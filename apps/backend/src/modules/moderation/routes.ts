import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { getIO, evictUserFromServer } from "../../realtime/io.js";
import { serializeAuditLogEntry, serializeMember } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { checkRoleHierarchy, getHighestRolePosition } from "../../permissions/permissionService.js";

const banSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().max(500).nullable().optional(),
});

const timeoutSchema = z.object({
  userId: z.string().min(1),
  until: z.string().datetime().nullable(),
});

export default async function moderationRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/:id/bans",
    {
      schema: { body: banSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.BAN_MEMBERS),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof banSchema>;
      const server = await prisma.server.findUnique({ where: { id: request.serverId! } });
      if (server?.ownerId === body.userId) throw new ForbiddenError("Cannot ban the server owner");

      // Same gap kick had: BAN_MEMBERS alone let a low-ranked member ban someone with a much
      // higher role. A target who has already left has no role position, so this is a no-op check
      // for them, exactly as intended — hierarchy only matters between current members.
      const targetHighest = await getHighestRolePosition(body.userId, request.serverId!);
      await checkRoleHierarchy(request.userId!, request.serverId!, targetHighest);

      const ban = await prisma.$transaction(async (tx) => {
        const created = await tx.ban.upsert({
          where: { serverId_userId: { serverId: request.serverId!, userId: body.userId } },
          create: {
            serverId: request.serverId!,
            userId: body.userId,
            reason: body.reason ?? null,
            bannedById: request.userId!,
          },
          update: { reason: body.reason ?? null, bannedById: request.userId! },
        });
        await tx.membership
          .delete({
            where: { userId_serverId: { userId: body.userId, serverId: request.serverId! } },
          })
          .catch(() => undefined);
        return created;
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.ban",
        targetId: body.userId,
        targetType: "member",
        metadata: { reason: body.reason ?? null },
      });

      // Tell the server their membership vanished, and force their sockets out of the server's
      // realtime rooms — the ban route previously had no realtime effect at all, so a banned
      // member kept receiving the live stream until reconnect even though REST 403'd them.
      getIO().to(`server:${request.serverId!}`).emit(ServerEvents.MEMBER_LEAVE, { userId: body.userId, serverId: request.serverId! });
      getIO().to(`user:${body.userId}`).emit(ServerEvents.SERVER_DELETE, { id: request.serverId! });
      await evictUserFromServer(body.userId, request.serverId!);

      reply.code(201);
      return { serverId: ban.serverId, userId: ban.userId, reason: ban.reason, createdAt: ban.createdAt.toISOString() };
    },
  );

  fastify.delete(
    "/:id/bans/:userId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.BAN_MEMBERS),
      ],
    },
    async (request, reply) => {
      const { userId: targetUserId } = request.params as { userId: string };
      const ban = await prisma.ban.findUnique({
        where: { serverId_userId: { serverId: request.serverId!, userId: targetUserId } },
      });
      if (!ban) throw new NotFoundError("Ban not found");

      await prisma.ban.delete({ where: { id: ban.id } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.unban",
        targetId: targetUserId,
        targetType: "member",
      });

      reply.code(204).send();
    },
  );

  fastify.get(
    "/:id/bans",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.BAN_MEMBERS),
      ],
    },
    async (request) => {
      // A ban list only ever grows — nothing removes rows except an explicit unban — so this is one
      // of the few server-scoped tables with genuinely unbounded growth. Newest first, capped.
      const bans = await prisma.ban.findMany({
        where: { serverId: request.serverId! },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      return bans.map((b) => ({
        serverId: b.serverId,
        userId: b.userId,
        reason: b.reason,
        bannedById: b.bannedById,
        createdAt: b.createdAt.toISOString(),
      }));
    },
  );

  fastify.post(
    "/:id/timeout",
    {
      schema: { body: timeoutSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.TIMEOUT_MEMBERS),
      ],
    },
    async (request) => {
      const body = request.body as z.infer<typeof timeoutSchema>;
      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: body.userId, serverId: request.serverId! } },
      });
      if (!membership) throw new NotFoundError("Member not found");

      const updated = await prisma.membership.update({
        where: { id: membership.id },
        data: { mutedUntil: body.until ? new Date(body.until) : null },
        include: { user: true, roles: { select: { roleId: true } } },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.timeout",
        targetId: body.userId,
        targetType: "member",
        metadata: { until: body.until },
      });

      return serializeMember(updated);
    },
  );

  fastify.get(
    "/:id/audit-log",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.VIEW_AUDIT_LOG),
      ],
    },
    async (request) => {
      const entries = await prisma.auditLogEntry.findMany({
        where: { serverId: request.serverId! },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return entries.map(serializeAuditLogEntry);
    },
  );
}
