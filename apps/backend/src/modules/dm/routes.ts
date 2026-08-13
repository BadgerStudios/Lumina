import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { checkContact } from "../age/service.js";
import { assertTrustedOrigin } from "../risk/service.js";
import { recordFlag } from "../flags/service.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { serializeDMConversation } from "../../lib/serialize.js";
import { BadRequestError, BlockedError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { getIO } from "../../realtime/io.js";
import { isBlockedEitherWay, areFriends } from "../friends/service.js";
// Imported rather than redeclared: this used to be a local copy of
// `{ author, attachments, reactions }`, which silently stopped being the full set the moment
// messages gained stickers, polls and link embeds. A hand-written include that drifts does not
// fail — it serializes the missing relations as "this message has none", and a MESSAGE_UPDATE
// built from it wipes a live poll off every client that receives it.
import { messageInclude } from "../messages/service.js";

const createDMSchema = z.object({
  participantIds: z.array(z.string()).min(1),
  isGroup: z.boolean().optional(),
  name: z.string().min(1).max(100).nullable().optional(),
});

const updateDMSchema = z.object({
  name: z.string().min(1).max(100).nullable(),
});

const addParticipantSchema = z.object({
  userId: z.string().min(1),
});

const conversationInclude = {
  participants: { include: { user: true } },
} as const;


async function loadLastMessage(conversationId: string) {
  return prisma.message.findFirst({
    where: { dmConversationId: conversationId, deletedAt: null },
    orderBy: { id: "desc" },
    include: messageInclude,
  });
}

export default async function dmRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    const participations = await prisma.dMParticipant.findMany({
      where: { userId: request.userId! },
      include: { conversation: { include: conversationInclude } },
    });

    const dtos = await Promise.all(
      participations.map(async (p) => {
        const lastMessage = await loadLastMessage(p.conversation.id);
        return serializeDMConversation(p.conversation, lastMessage, request.userId!);
      }),
    );
    return dtos;
  });

  fastify.post("/", { schema: { body: createDMSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof createDMSchema>;
    const isGroup = body.isGroup ?? body.participantIds.length > 1;
    const allParticipantIds = Array.from(new Set([request.userId!, ...body.participantIds]));

    if (allParticipantIds.length < 2) {
      throw new BadRequestError("A DM conversation needs at least one other participant");
    }

    // Every participant is loaded ONCE here and reused by every check below.
    //
    // Existence was never verified before this: an id that isn't in User fell straight through to
    // the create, where Postgres rejected it on DMParticipant_userId_fkey and the client got an
    // opaque 500 with nothing actionable in it. That is exactly what a stale client sends — a
    // profile card or member row rendered before the account was deleted, or an old bundle that
    // still had the account cached. The person clicking "Message" then sees a generic failure on
    // every retry with no way to understand it.
    const users = await prisma.user.findMany({
      where: { id: { in: allParticipantIds } },
      select: {
        id: true,
        isBot: true,
        isMinor: true,
        ageRecordedAt: true,
        allowDmsFromNonFriends: true,
      },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const missing = allParticipantIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      // Logged with the ids because the interesting question is which surface handed the client a
      // dead id — the message the caller gets stays deliberately vague either way.
      request.log.warn({ missing, requestedBy: request.userId }, "dm creation referenced unknown users");
      throw new NotFoundError(
        missing.length === allParticipantIds.length - 1
          ? "That account no longer exists"
          : "One or more of those accounts no longer exist",
      );
    }

    // Bot accounts are ordinary User rows (schema.prisma: isBot), so nothing structural stopped a
    // DM with one — but a bot has no inbox and nothing would ever read the message.
    const bot = users.find((u) => u.isBot && u.id !== request.userId);
    if (bot) throw new BadRequestError("You can't start a conversation with a bot");

    // Only meaningful for a real 1:1 — group DM membership isn't blocked on this (matches most
    // chat apps: blocking stops new 1:1 contact, not being in the same group someone else made).
    if (!isGroup && allParticipantIds.length === 2) {
      const [a, b] = allParticipantIds;
      if (await isBlockedEitherWay(a, b)) {
        throw new ForbiddenError("Can't start a conversation with this user");
      }
    }

    if (!isGroup && allParticipantIds.length === 2) {
      // Try to reuse an existing 1:1 conversation between exactly these two users.
      const existing = await prisma.dMConversation.findFirst({
        where: {
          isGroup: false,
          participants: { every: { userId: { in: allParticipantIds } } },
          AND: allParticipantIds.map((uid) => ({ participants: { some: { userId: uid } } })),
        },
        include: conversationInclude,
      });
      if (existing && existing.participants.length === 2) {
        const lastMessage = await loadLastMessage(existing.id);
        return serializeDMConversation(existing, lastMessage, request.userId!);
      }

      // Privacy & Safety setting (default true) — only gates a genuinely NEW 1:1 conversation
      // (the existing-conversation reuse above already returned if one exists), so flipping
      // this off never retroactively closes a DM that was already open.
      const [a, b] = allParticipantIds;
      const otherId = a === request.userId ? b : a;
      const other = byId.get(otherId)!;
      if (!other.allowDmsFromNonFriends && !(await areFriends(request.userId!, otherId))) {
        throw new ForbiddenError("This user only accepts messages from friends");
      }
    }

    // Age separation, checked for EVERY participant including group DMs — a group is the obvious
    // way around a rule that only looked at 1:1 conversations.
    const creator = byId.get(request.userId!);
    const others = users.filter((u) => u.id !== request.userId);
    if (creator) {
      // Own missing age first, and as its own error: it is the one case the person can actually
      // fix, and the client turns AGE_MISSING into the age prompt rather than a dead refusal.
      // Previously an account with no age on record was silently treated as a minor, which meant
      // this refusal read as "you can't talk to this person" when the real answer was "answer one
      // question and you can".
      if (creator.ageRecordedAt === null) {
        void recordFlag({
          userId: request.userId!,
          reasonCode: "AGE_MISSING",
          detail: "dm creation blocked; age not on record",
        });
        throw new BlockedError("AGE_MISSING");
      }

      const blocked = others.find((o) => checkContact(creator, o) !== "ok");
      if (blocked) {
        const reason = checkContact(creator, blocked);
        void recordFlag({
          userId: request.userId!,
          reasonCode: reason === "unknown-other" ? "AGE_MISSING" : "AGE_CONTACT_RESTRICTED",
          detail: `dm creation with ${blocked.id} (${reason})`,
        });
        // The other person's missing age gets its own wording — it is not a restriction on the
        // person asking, and telling them "you can't message this person" for something entirely
        // outside their control is the kind of refusal that generates support tickets.
        //
        // Both branches stay vague about WHY in the age-mismatch case: naming it would disclose a
        // stranger's age bracket to anyone willing to probe for it.
        throw new ForbiddenError(
          reason === "unknown-other"
            ? "That account hasn't finished setting up yet"
            : "You can't start a conversation with one of these people",
        );
      }
    }

    // Connection-origin gate, last of the checks and deliberately narrow: a brand-new account on
    // a VPN or Tor exit can still open a DM with someone it is already friends with, and can still
    // reply in any conversation that already exists (the reuse lookup above returned before
    // reaching here). Only reaching out to a stranger is held back — which is the only one of those
    // that unsolicited-message spam actually needs.
    const strangers = await Promise.all(
      others.map(async (o) => ((await areFriends(request.userId!, o.id)) ? null : o.id)),
    );
    if (strangers.some(Boolean)) {
      await assertTrustedOrigin(request, request.userId!, "dm to a non-friend");
    }

    const conversation = await prisma.dMConversation.create({
      data: {
        isGroup,
        name: body.name ?? null,
        participants: { create: allParticipantIds.map((userId) => ({ userId })) },
      },
      include: conversationInclude,
    });

    const dto = serializeDMConversation(conversation, null, request.userId!);
    for (const uid of allParticipantIds) {
      getIO().to(`user:${uid}`).emit(ServerEvents.DM_CREATE, dto);
    }

    reply.code(201);
    return dto;
  });

  fastify.patch("/:id", { schema: { body: updateDMSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof updateDMSchema>;
    const conversation = await prisma.dMConversation.findUnique({ where: { id }, include: conversationInclude });
    if (!conversation) throw new NotFoundError("Conversation not found");
    if (!conversation.isGroup) throw new BadRequestError("Only group DMs can be renamed");
    if (!conversation.participants.some((p) => p.userId === request.userId)) {
      throw new ForbiddenError("Not a participant in this conversation");
    }

    const updated = await prisma.dMConversation.update({
      where: { id },
      data: { name: body.name },
      include: conversationInclude,
    });

    const lastMessage = await loadLastMessage(id);
    const dto = serializeDMConversation(updated, lastMessage, request.userId!);
    for (const p of updated.participants) {
      getIO().to(`user:${p.userId}`).emit(ServerEvents.DM_UPDATE, dto);
    }
    return dto;
  });

  fastify.post(
    "/:id/participants",
    { schema: { body: addParticipantSchema }, preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof addParticipantSchema>;
      const conversation = await prisma.dMConversation.findUnique({ where: { id }, include: conversationInclude });
      if (!conversation) throw new NotFoundError("Conversation not found");
      if (!conversation.isGroup) throw new BadRequestError("Can't add participants to a 1:1 conversation");
      if (!conversation.participants.some((p) => p.userId === request.userId)) {
        throw new ForbiddenError("Not a participant in this conversation");
      }
      if (conversation.participants.some((p) => p.userId === body.userId)) {
        throw new BadRequestError("Already a participant");
      }

      await prisma.dMParticipant.create({ data: { conversationId: id, userId: body.userId } });
      const updated = await prisma.dMConversation.update({ where: { id }, data: {}, include: conversationInclude });
      const lastMessage = await loadLastMessage(id);

      for (const p of updated.participants) {
        const dto = serializeDMConversation(updated, lastMessage, p.userId);
        getIO().to(`user:${p.userId}`).emit(ServerEvents.DM_UPDATE, dto);
      }
      // The newly-added participant needs the DM_CREATE shape too — their own DM list query
      // has never seen this conversationId before, so an update-only broadcast has nothing to
      // patch (same reasoning DM_CREATE already handles for a brand new conversation).
      const newDto = serializeDMConversation(updated, lastMessage, body.userId);
      getIO().to(`user:${body.userId}`).emit(ServerEvents.DM_CREATE, newDto);

      reply.code(201);
      return newDto;
    },
  );

  fastify.delete("/:id/participants/:userId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id, userId: targetUserId } = request.params as { id: string; userId: string };
    const conversation = await prisma.dMConversation.findUnique({ where: { id }, include: conversationInclude });
    if (!conversation) throw new NotFoundError("Conversation not found");
    if (!conversation.isGroup) throw new BadRequestError("Can't remove participants from a 1:1 conversation");
    if (!conversation.participants.some((p) => p.userId === request.userId)) {
      throw new ForbiddenError("Not a participant in this conversation");
    }
    if (!conversation.participants.some((p) => p.userId === targetUserId)) {
      throw new NotFoundError("That user isn't a participant");
    }
    if (conversation.participants.length <= 2) {
      throw new BadRequestError("A group DM needs at least 2 participants — add someone before removing another");
    }

    await prisma.dMParticipant.delete({ where: { conversationId_userId: { conversationId: id, userId: targetUserId } } });
    const updated = await prisma.dMConversation.update({ where: { id }, data: {}, include: conversationInclude });
    const lastMessage = await loadLastMessage(id);

    for (const p of updated.participants) {
      const dto = serializeDMConversation(updated, lastMessage, p.userId);
      getIO().to(`user:${p.userId}`).emit(ServerEvents.DM_UPDATE, dto);
    }
    // The removed participant's own DM list should drop this conversation — reuse DM_DELETE-
    // shaped payload semantics via a dedicated event rather than overloading DM_UPDATE with a
    // "you're no longer here" case the frontend would have to special-case.
    getIO().to(`user:${targetUserId}`).emit(ServerEvents.DM_PARTICIPANT_REMOVED, { conversationId: id });

    reply.code(204).send();
  });

  // Read receipts — DMParticipant.lastReadMessageId already existed in the schema with zero
  // routes using it, mirrors the ChannelReadState pattern (modules/readState/service.ts).
  fastify.patch("/:id/read", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: id, userId: request.userId! } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");

    const latest = await prisma.message.findFirst({
      where: { dmConversationId: id, deletedAt: null },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (!latest) {
      reply.code(204).send();
      return;
    }

    await prisma.dMParticipant.update({
      where: { conversationId_userId: { conversationId: id, userId: request.userId! } },
      data: { lastReadMessageId: latest.id },
    });

    const updated = await prisma.dMConversation.findUnique({ where: { id }, include: conversationInclude });
    const lastMessage = await loadLastMessage(id);
    if (updated) {
      for (const p of updated.participants) {
        const dto = serializeDMConversation(updated, lastMessage, p.userId);
        getIO().to(`user:${p.userId}`).emit(ServerEvents.DM_READ_UPDATE, dto);
      }
    }

    reply.code(204).send();
  });
}
