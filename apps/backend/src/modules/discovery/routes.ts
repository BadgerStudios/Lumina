import type { FastifyInstance } from "fastify";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { serializeMember } from "../../lib/serialize.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";
import { getDiscovery } from "./service.js";

// Same include inviteRoutes uses — serializeMember needs user + role ids.
const memberInclude = { user: true, roles: { select: { roleId: true } } } as const;

/** Mounted under /api/discovery. Adult-gated wholesale — see service.ts for why. */
export default async function discoveryRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    return getDiscovery(request.userId!);
  });

  /**
   * Join a discoverable server without an invite.
   *
   * A separate route from invite join on purpose: an invite is a capability someone handed you,
   * and this is an open door the server chose to leave open. The checks differ accordingly — no
   * code to validate or consume, but the `discoverable` flag is re-read HERE, at join time, so a
   * server that turns discovery off is closed immediately even to someone with the id in hand.
   */
  fastify.post("/servers/:id/join", { preHandler: [requireAuth, requireAdult] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const server = await prisma.server.findUnique({ where: { id }, select: { id: true, discoverable: true } });
    // 404 for both missing and non-discoverable: a 403 would confirm a private server's existence
    // to anyone probing ids, which is the leak the opt-in exists to prevent.
    if (!server || !server.discoverable) throw new NotFoundError("Server not found");

    const ban = await prisma.ban.findUnique({
      where: { serverId_userId: { serverId: id, userId: request.userId! } },
    });
    if (ban) throw new ForbiddenError("You are banned from this server");

    const existing = await prisma.membership.findUnique({
      where: { userId_serverId: { userId: request.userId!, serverId: id } },
      include: memberInclude,
    });
    if (existing) return serializeMember(existing);

    const membership = await prisma.membership.create({
      data: { userId: request.userId!, serverId: id },
      include: memberInclude,
    });

    await recordAuditLog({
      serverId: id,
      actorId: request.userId!,
      actionType: "member.join",
      targetId: request.userId!,
      targetType: "member",
      metadata: { via: "discovery" },
    });

    const dto = serializeMember(membership);
    getIO().to(`server:${id}`).emit(ServerEvents.MEMBER_JOIN, dto);
    reply.code(201);
    return dto;
  });
}
