import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { serializeMessage, serializeUser } from "../../lib/serialize.js";
import { messageInclude } from "../messages/service.js";
import {
  approveContact,
  ensurePairingCode,
  getMinorState,
  listChildren,
  redeemPairingCode,
  requireActiveLink,
  revokeApprovedContact,
  revokeLink,
} from "./service.js";

const redeemSchema = z.object({ code: z.string().min(4).max(16) });
const approveSchema = z.object({ username: z.string().min(1).max(32), note: z.string().max(200).optional() });

/**
 * Mounted under /api/parental.
 *
 * Every supervision route resolves through requireActiveLink first, so a parent can only ever read
 * a child they are currently responsible for — revoking the link closes the window immediately,
 * with no separate cleanup to remember.
 */
export default async function parentalRoutes(fastify: FastifyInstance) {
  /** The child's own view: am I locked, and what code do I give my parent? */
  fastify.get("/me", { preHandler: [requireAuth] }, async (request) => {
    const state = await getMinorState(request.userId!);
    if (!state.isMinor) return { isMinor: false, locked: false, pairingCode: null, parent: null };

    // Mint on first read rather than waiting for a separate call. A locked minor's entire route
    // out of the lock IS this code, so an endpoint that reports "locked, code: null" describes a
    // dead end — and the client would have to know to go ask for one.
    if (!state.pairingCode) await ensurePairingCode(request.userId!);

    const link = await prisma.parentLink.findUnique({
      where: { childUserId: request.userId! },
      include: { parent: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    return {
      isMinor: true,
      locked: state.locked,
      // Read from the link, not from `state` — `state` was captured before ensurePairingCode ran
      // above, so using it would return the very null the mint was there to replace.
      pairingCode: link && link.status !== "REVOKED" ? link.pairingCode : null,
      status: link?.status ?? null,
      // Named plainly, because the child is entitled to know who can see their account. This is
      // the data behind the persistent supervision notice in the client.
      parent: link?.parent ?? null,
    };
  });

  fastify.post("/me/pairing-code", { preHandler: [requireAuth] }, async (request) => {
    return ensurePairingCode(request.userId!);
  });

  /** An adult redeems a child's code. */
  fastify.post(
    "/redeem",
    { schema: { body: redeemSchema }, preHandler: [requireAuth] },
    async (request) => {
      const { code } = request.body as z.infer<typeof redeemSchema>;
      const link = await redeemPairingCode(request.userId!, code);
      return { linkId: link.id, child: link.child };
    },
  );

  fastify.get("/children", { preHandler: [requireAuth] }, async (request) => {
    return listChildren(request.userId!);
  });

  fastify.delete("/links/:linkId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    await revokeLink(request.userId!, linkId);
    reply.code(204).send();
  });

  // ---------------------------------------------------------------- supervision

  /** Everything the child has posted, newest first, across channels and DMs alike. */
  fastify.get("/children/:childId/messages", { preHandler: [requireAuth] }, async (request) => {
    const { childId } = request.params as { childId: string };
    const { before } = request.query as { before?: string };
    await requireActiveLink(request.userId!, childId);

    const messages = await prisma.message.findMany({
      where: {
        authorId: childId,
        deletedAt: null,
        ...(before ? { id: { lt: BigInt(before) } } : {}),
      },
      include: messageInclude,
      orderBy: { id: "desc" },
      take: 50,
    });
    // A parent reading this list needs to know WHERE each message was said, not just what — a
    // bare "hi" with no context is not actionable. One batched lookup rather than an include so
    // serializeMessage's contract stays untouched.
    const channelIds = [...new Set(messages.map((m) => m.channelId).filter((id): id is string => !!id))];
    const channels = channelIds.length
      ? await prisma.channel.findMany({
          where: { id: { in: channelIds } },
          select: { id: true, name: true, server: { select: { name: true } } },
        })
      : [];
    const context = new Map(channels.map((c) => [c.id, { channel: c.name, server: c.server.name }]));
    return messages.map((m) => ({
      ...serializeMessage(m, childId),
      where: m.channelId ? (context.get(m.channelId) ?? null) : null,
    }));
  });

  /**
   * Everyone the child has exchanged DMs with, and how recently.
   *
   * The list a parent actually needs first: not "what was said" but "who is talking to my child".
   * Adults in that list are flagged, because an adult in a minor's DMs is precisely the thing the
   * whole feature exists to make visible.
   */
  fastify.get("/children/:childId/contacts", { preHandler: [requireAuth] }, async (request) => {
    const { childId } = request.params as { childId: string };
    await requireActiveLink(request.userId!, childId);

    const conversations = await prisma.dMParticipant.findMany({
      where: { userId: childId },
      select: { conversationId: true },
    });
    const ids = conversations.map((c) => c.conversationId);
    if (ids.length === 0) return [];

    const others = await prisma.dMParticipant.findMany({
      where: { conversationId: { in: ids }, userId: { not: childId } },
      include: { user: true },
    });

    const seen = new Map<string, { user: ReturnType<typeof serializeUser>; isAdult: boolean; conversationId: string }>();
    for (const o of others) {
      if (seen.has(o.userId)) continue;
      seen.set(o.userId, {
        user: serializeUser(o.user),
        // An unrecorded age is reported as an adult here on purpose. Everywhere else "unknown" is
        // treated as not-permission; on a parent's screen the cautious reading is the one that
        // surfaces the contact rather than quietly filing it as harmless.
        isAdult: !o.user.isMinor,
        conversationId: o.conversationId,
      });
    }
    return [...seen.values()];
  });

  fastify.get("/children/:childId/servers", { preHandler: [requireAuth] }, async (request) => {
    const { childId } = request.params as { childId: string };
    await requireActiveLink(request.userId!, childId);
    const memberships = await prisma.membership.findMany({
      where: { userId: childId },
      include: { server: { select: { id: true, name: true, iconUrl: true, description: true } } },
      orderBy: { joinedAt: "desc" },
    });
    return memberships.map((m) => ({ joinedAt: m.joinedAt.toISOString(), server: m.server }));
  });

  fastify.get("/children/:childId/friends", { preHandler: [requireAuth] }, async (request) => {
    const { childId } = request.params as { childId: string };
    await requireActiveLink(request.userId!, childId);
    const rows = await prisma.friendRequest.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: childId }, { addresseeId: childId }],
      },
      include: { requester: true, addressee: true },
    });
    return rows.map((r) => {
      const other = r.requesterId === childId ? r.addressee : r.requester;
      return { user: serializeUser(other), isAdult: !other.isMinor };
    });
  });

  // ---------------------------------------------------------------- approved contacts

  fastify.post(
    "/children/:childId/approved",
    { schema: { body: approveSchema }, preHandler: [requireAuth] },
    async (request, reply) => {
      const { childId } = request.params as { childId: string };
      const { username, note } = request.body as z.infer<typeof approveSchema>;
      const target = await approveContact(request.userId!, childId, username, note);
      reply.code(201);
      return target;
    },
  );

  fastify.delete("/children/:childId/approved/:userId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { childId, userId } = request.params as { childId: string; userId: string };
    await revokeApprovedContact(request.userId!, childId, userId);
    reply.code(204).send();
  });
}
