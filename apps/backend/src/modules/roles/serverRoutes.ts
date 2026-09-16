import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMember, serializeRole } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { assertPermissionSubset, checkRoleHierarchy, getHighestRolePosition, hasAdminOrOwner } from "../../permissions/permissionService.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const createRoleSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.number().int().nullable().optional(),
  permissions: z.string().regex(/^\d+$/).default("0"),
  position: z.number().int().positive().optional(),
  mentionable: z.boolean().optional(),
  hoist: z.boolean().optional(),
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
      await assertPermissionSubset(request.userId!, request.serverId!, BigInt(body.permissions));

      const role = await prisma.role.create({
        data: {
          serverId: request.serverId!,
          name: body.name,
          color: body.color ?? null,
          permissions: BigInt(body.permissions),
          position,
          mentionable: body.mentionable ?? true,
          hoist: body.hoist ?? false,
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

      // Validate the whole target set against THIS server before any write, on BOTH paths —
      // the transaction below keys each update on role id ALONE, with no serverId scope. Three
      // things ride on this fetch:
      //   1. Cross-server safety. Without it the admin/owner bypass path does no scoped lookup at
      //      all, so knowing a role id from a different server was enough to reposition it. A count
      //      mismatch means an id in the list is not a role of this server.
      //   2. @everyone stays put. It is pinned at position 0 and the single-role PATCH route
      //      already refuses to move it; matching that here keeps the batch route from being the
      //      way around it.
      //   3. The SOURCE-position hierarchy guard. The destination check above never looked at where
      //      a role currently sits, so a MANAGE_ROLES holder could pull a role ranked above them
      //      down below their own rank in one request — after which every other role route, which
      //      checks the CURRENT position via checkRoleHierarchy, would treat it as fair game.
      const targeted = await prisma.role.findMany({
        where: { id: { in: body.order.map((e) => e.id) }, serverId: request.serverId! },
        select: { id: true, position: true, isDefault: true },
      });
      if (targeted.length !== body.order.length) throw new NotFoundError("A role in this list was not found");
      if (targeted.some((r) => r.isDefault)) throw new BadRequestError("The default role can't be reordered");
      if (!bypass && targeted.some((r) => r.position >= actorHighest)) {
        throw new ForbiddenError("Cannot move a role at or above your own highest role");
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
      // Handing out a role is granting its permissions: same rule as writing them.
      await assertPermissionSubset(request.userId!, request.serverId!, role.permissions);

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
