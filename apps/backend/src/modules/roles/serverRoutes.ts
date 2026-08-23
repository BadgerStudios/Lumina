import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMember, serializeRole } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { checkRoleHierarchy, getHighestRolePosition, hasAdminOrOwner } from "../../permissions/permissionService.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const createRoleSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.number().int().nullable().optional(),
  permissions: z.string().regex(/^\d+$/).default("0"),
  position: z.number().int().positive().optional(),
  mentionable: z.boolean().optional(),
});

const reorderSchema = z.object({
  order: z.array(z.object({ id: z.string(), position: z.number().int() })).min(1),
});

const memberInclude = { user: true, roles: { select: { roleId: true } } } as const;

/** Mounted under /api/servers */
export default async function serverRolesRoutes(fastify: FastifyInstance) {
  // NOTE: added for the web client — every member (not just MANAGE_ROLES holders) needs
  // the full role list (name/color/position/permissions) to render member-list role
  // colors/grouping and to compute their own effective permission bitfield client-side
  // (UX-only; every mutation is still independently permission-checked server-side).
  // Same authorization tier as GET /:id/members and GET /:id/channels: membership only.
  fastify.get(
    "/:id/roles",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const roles = await prisma.role.findMany({
        where: { serverId: request.serverId! },
        orderBy: { position: "asc" },
      });
      return roles.map(serializeRole);
    },
  );

  fastify.post(
    "/:id/roles",
    {
      schema: { body: createRoleSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createRoleSchema>;

      const bypass = await hasAdminOrOwner(request.userId!, request.serverId!);
      const actorHighest = bypass ? Number.MAX_SAFE_INTEGER : await getHighestRolePosition(request.userId!, request.serverId!);

      const maxPosition = await prisma.role.aggregate({
        where: { serverId: request.serverId! },
        _max: { position: true },
      });
      let position = body.position ?? (maxPosition._max.position ?? 0) + 1;
      if (!bypass && position >= actorHighest) {
        throw new ForbiddenError("Cannot create a role at or above your own highest role");
      }

      const role = await prisma.role.create({
        data: {
          serverId: request.serverId!,
          name: body.name,
          color: body.color ?? null,
          permissions: BigInt(body.permissions),
          position,
          mentionable: body.mentionable ?? true,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "role.create",
        targetId: role.id,
        targetType: "role",
      });

      const dto = serializeRole(role);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.ROLE_CREATE, dto);
      reply.code(201);
      return dto;
    },
  );

  fastify.patch(
    "/:id/roles/reorder",
    {
      schema: { body: reorderSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request) => {
      const body = request.body as z.infer<typeof reorderSchema>;

      const bypass = await hasAdminOrOwner(request.userId!, request.serverId!);
      const actorHighest = bypass ? Number.MAX_SAFE_INTEGER : await getHighestRolePosition(request.userId!, request.serverId!);
      if (!bypass && body.order.some((e) => e.position >= actorHighest)) {
        throw new ForbiddenError("Cannot move a role to or above your own highest role");
      }

      // The check above only guards the DESTINATION position — it never looked at where a role
      // currently sits. That let a MANAGE_ROLES holder (not admin/owner) submit a reorder that
      // pulls a role currently ranked ABOVE them down to a position below their own rank in one
      // request: every other role-mutating route (PATCH/DELETE role, grant/revoke, channel
      // overwrites) checks the role's CURRENT position via checkRoleHierarchy, so once this had
      // lowered it, those routes would treat it as fair game. Fetching current positions here also
      // closes a second gap for free: the update below keyed purely on role id with no serverId
      // scope, so an id belonging to a DIFFERENT server would have silently been accepted too.
      if (!bypass) {
        const current = await prisma.role.findMany({
          where: { id: { in: body.order.map((e) => e.id) }, serverId: request.serverId! },
          select: { id: true, position: true },
        });
        if (current.length !== body.order.length) throw new NotFoundError("A role in this list was not found");
        if (current.some((r) => r.position >= actorHighest)) {
          throw new ForbiddenError("Cannot move a role at or above your own highest role");
        }
      }

      await prisma.$transaction(
        body.order.map((entry) =>
          prisma.role.update({ where: { id: entry.id }, data: { position: entry.position } }),
        ),
      );

      const roles = await prisma.role.findMany({ where: { serverId: request.serverId! }, orderBy: { position: "asc" } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "role.reorder",
        metadata: body,
      });

      const dtos = roles.map(serializeRole);
      for (const dto of dtos) getIO().to(`server:${request.serverId}`).emit(ServerEvents.ROLE_UPDATE, dto);
      return dtos;
    },
  );

  fastify.post(
    "/:id/members/:userId/roles/:roleId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request, reply) => {
      const { userId: targetUserId, roleId } = request.params as { userId: string; roleId: string };

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role || role.serverId !== request.serverId) throw new NotFoundError("Role not found");

      await checkRoleHierarchy(request.userId!, request.serverId!, role.position);

      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId: request.serverId! } },
      });
      if (!membership) throw new NotFoundError("Member not found");

      await prisma.roleAssignment.upsert({
        where: { membershipId_roleId: { membershipId: membership.id, roleId } },
        create: { membershipId: membership.id, roleId },
        update: {},
      });

      const updated = await prisma.membership.findUnique({ where: { id: membership.id }, include: memberInclude });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.role.grant",
        targetId: targetUserId,
        targetType: "member",
        metadata: { roleId },
      });

      const dto = serializeMember(updated!);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.MEMBER_UPDATE, dto);
      reply.code(200);
      return dto;
    },
  );

  fastify.delete(
    "/:id/members/:userId/roles/:roleId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request) => {
      const { userId: targetUserId, roleId } = request.params as { userId: string; roleId: string };

      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role || role.serverId !== request.serverId) throw new NotFoundError("Role not found");

      await checkRoleHierarchy(request.userId!, request.serverId!, role.position);

      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId: request.serverId! } },
      });
      if (!membership) throw new NotFoundError("Member not found");

      await prisma.roleAssignment
        .delete({ where: { membershipId_roleId: { membershipId: membership.id, roleId } } })
        .catch(() => undefined);

      const updated = await prisma.membership.findUnique({ where: { id: membership.id }, include: memberInclude });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.role.revoke",
        targetId: targetUserId,
        targetType: "member",
        metadata: { roleId },
      });

      const dto = serializeMember(updated!);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.MEMBER_UPDATE, dto);
      return dto;
    },
  );
}
