import type { FastifyInstance } from "fastify";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeInvite, serializeMember } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const memberInclude = { user: true, roles: { select: { roleId: true } } } as const;

/** Mounted under /api/invites */
export default async function inviteRoutes(fastify: FastifyInstance) {
  // Public: no auth required, used to preview an invite before joining.
  fastify.get("/:code", async (request) => {
    const { code } = request.params as { code: string };
    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || invite.revokedAt) throw new NotFoundError("Invite not found");
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new NotFoundError("Invite expired");
    return serializeInvite(invite);
  });

  fastify.post("/:code/join", { preHandler: [requireAuth] }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const invite = await prisma.invite.findUnique({ where: { code } });
    if (!invite || invite.revokedAt) throw new NotFoundError("Invite not found");
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new NotFoundError("Invite expired");
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) throw new BadRequestError("Invite has reached its max uses");

    const ban = await prisma.ban.findUnique({
      where: { serverId_userId: { serverId: invite.serverId, userId: request.userId! } },
    });
    if (ban) throw new ForbiddenError("You are banned from this server");

    const existing = await prisma.membership.findUnique({
      where: { userId_serverId: { userId: request.userId!, serverId: invite.serverId } },
      include: memberInclude,
    });
    if (existing) {
      return serializeMember(existing);
    }

    const membership = await prisma.$transaction(async (tx) => {
      const created = await tx.membership.create({
        data: { userId: request.userId!, serverId: invite.serverId },
        include: memberInclude,
      });
      await tx.invite.update({ where: { code }, data: { uses: { increment: 1 } } });
      return created;
    });

    await recordAuditLog({
      serverId: invite.serverId,
      actorId: request.userId!,
      actionType: "member.join",
      targetId: request.userId!,
      targetType: "member",
      metadata: { via: "invite", code },
    });

    const dto = serializeMember(membership);
    getIO().to(`server:${invite.serverId}`).emit(ServerEvents.MEMBER_JOIN, dto);

    reply.code(201);
    return dto;
  });

  fastify.delete(
    "/:code",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromInviteParam("code")),
        requirePermission(Permissions.MANAGE_SERVER),
      ],
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      await prisma.invite.update({ where: { code }, data: { revokedAt: new Date() } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "invite.revoke",
        targetId: code,
        targetType: "invite",
      });

      reply.code(204).send();
    },
  );
}
