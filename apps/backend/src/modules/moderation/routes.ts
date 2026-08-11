import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeAuditLogEntry, serializeMember } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";

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
      const bans = await prisma.ban.findMany({ where: { serverId: request.serverId! }, orderBy: { createdAt: "desc" } });
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
