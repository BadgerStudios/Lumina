import type { FastifyInstance } from "fastify";
import { assertNotLockedMinor } from "../parental/service.js";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeInvite, serializeMember } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const memberInclude = { user: true, roles: { select: { roleId: true } } } as const;

/** Mounted under /api/invites */

/**
 * Resolves an invite code that may be either a generated Invite or a server's vanity code.
 *
 * A vanity code is not an Invite row — it lives on Server — so `/invite/<vanity>` would 404 without
 * this. Returned in the Invite shape so both paths share one join implementation; a synthesised
 * vanity invite never expires and has no use cap, which is the point of a permanent custom link.
 *
 * The Invite table is checked FIRST. Both namespaces are guarded against collision when a vanity is
 * set, but an ordering has to be chosen, and preferring the real row means a pre-existing invite
 * keeps working even if a collision were somehow introduced out of band.
 */
async function resolveInviteCode(code: string) {
  const invite = await prisma.invite.findUnique({ where: { code } });
  if (invite) return { invite, isVanity: false as const };

  const server = await prisma.server.findUnique({
    where: { vanityCode: code.toLowerCase() },
    select: { id: true },
  });
  if (!server) return null;

  return {
    invite: {
      code,
      serverId: server.id,
      creatorId: "",
      maxUses: null,
      uses: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    },
    isVanity: true as const,
  };
}

export default async function inviteRoutes(fastify: FastifyInstance) {
  // Public: no auth required, used to preview an invite before joining.
  fastify.get("/:code", async (request) => {
    const { code } = request.params as { code: string };
    const resolved = await resolveInviteCode(code);
    if (!resolved) throw new NotFoundError("Invite not found");
    const { invite } = resolved;
    if (invite.revokedAt) throw new NotFoundError("Invite not found");
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new NotFoundError("Invite expired");
    return serializeInvite(invite);
  });

  fastify.post("/:code/join", { preHandler: [requireAuth] }, async (request, reply) => {
    // Joining a server makes the account visible in a member list, so it is gated the same way
    // messaging is.
    await assertNotLockedMinor(request.userId!);

    // Bot tokens authenticate through requireAuth like anyone else, which used to make an invite
    // code a complete bypass of consent: whoever RAN the bot could add it anywhere they had a
    // code, and the server's admins never approved anything. A bot is admitted by someone who
    // administers the server, through /oauth2/authorize?scope=bot, or not at all.
    const joiner = await prisma.user.findUnique({ where: { id: request.userId! }, select: { isBot: true } });
    if (joiner?.isBot) {
      throw new ForbiddenError("Bots are added through an install link (/oauth2/authorize?scope=bot), not by redeeming an invite");
    }
    const { code } = request.params as { code: string };
    const resolved = await resolveInviteCode(code);
    if (!resolved) throw new NotFoundError("Invite not found");
    const { invite, isVanity } = resolved;
    if (invite.revokedAt) throw new NotFoundError("Invite not found");
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
      // A vanity code has no Invite row; incrementing would throw on a record that does not exist.
      if (!isVanity) {
        // Conditional on uses still being below the cap AT WRITE TIME, not the read-time check
        // above: two concurrent joins on a maxUses:1 invite could otherwise both pass that read
        // and both succeed, since the read and the increment were two separate steps with no lock
        // between them. Checked and incremented first, inside the same transaction as the
        // membership row below, so losing the race rolls back the whole join — no membership is
        // created for whoever missed a "single-use" invite that was already used.
        const result = await tx.invite.updateMany({
          where: { code, ...(invite.maxUses !== null ? { uses: { lt: invite.maxUses } } : {}) },
          data: { uses: { increment: 1 } },
        });
        if (result.count === 0) throw new BadRequestError("Invite has reached its max uses");
      }
      const created = await tx.membership.create({
        data: { userId: request.userId!, serverId: invite.serverId },
        include: memberInclude,
      });
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
