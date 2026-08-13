import { Permissions, ServerEvents } from "@lumina/shared";
import type { MessageDTO, MentionFeedItemDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMessage } from "../../lib/serialize.js";
import { checkPermission, checkChannelPermission } from "../../permissions/permissionService.js";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../../lib/errors.js";
import { getIO } from "../../realtime/io.js";
import { parseCursor, parseLimit } from "../../lib/pagination.js";
import { syncMessageMentions } from "./mentions.js";
import { sendPushToUser } from "../../lib/push.js";
import { runMessageAutomations } from "../addons/runtime.js";
import { assertPassesAutoMod } from "../automod/service.js";
import { assertPassesVerification } from "../servers/verification.js";
import { scheduleLinkPreviews } from "../../lib/linkPreview.js";

/**
 * Shared message service — imported by BOTH the REST routes
 * (modules/messages/routes.ts) and the Socket.IO handlers
 * (realtime/handlers/message.ts) so permission checks, persistence, and
 * broadcast happen in exactly one place regardless of transport.
 */

/**
 * Everything serializeMessage needs, in one place so no caller can accidentally load a message
 * without its poll or its embeds and serialize it as though it had none.
 *
 * The poll's votes are pulled as bare userIds rather than counted with an aggregate: a tally needs
 * both the totals and "did *I* vote", and a `_count` gives only the first, so the second would cost
 * a second query per poll per message.
 */
export const messageInclude = {
  author: true,
  attachments: true,
  reactions: true,
  sticker: true,
  poll: { include: { options: { include: { votes: { select: { userId: true } } } } } },
  embeds: { include: { preview: true } },
} as const;

export interface CreateMessageAttachmentInput {
  id?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width?: number | null;
  height?: number | null;
}

async function assertNotMuted(userId: string, serverId: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  if (!membership) throw new ForbiddenError("Not a member of this server");
  if (membership.mutedUntil && membership.mutedUntil.getTime() > Date.now()) {
    throw new ForbiddenError("You are timed out in this server");
  }
}

function assertHasContent(
  content: string,
  attachments?: CreateMessageAttachmentInput[],
  extras?: { stickerId?: string | null; pollId?: string | null },
): void {
  // A sticker or a poll is a message body in its own right — requiring text alongside one would
  // make "send a sticker" impossible, which is the entire feature.
  if (extras?.stickerId || extras?.pollId) return;
  if (!content.trim() && (!attachments || attachments.length === 0)) {
    throw new BadRequestError("Message must have content or at least one attachment");
  }
}

/**
 * A sticker may only be sent in the server that owns it.
 *
 * Without this check, `stickerId` is an arbitrary client-supplied id: anyone who could see a
 * sticker's id in one server could post it in another, which quietly turns every server's sticker
 * set into a global one and leaks the existence of stickers in servers the sender is not in.
 */
async function assertStickerUsable(stickerId: string, serverId: string | null): Promise<void> {
  const sticker = await prisma.sticker.findUnique({ where: { id: stickerId }, select: { serverId: true } });
  if (!sticker) throw new NotFoundError("Sticker not found");
  if (sticker.serverId !== serverId) {
    throw new ForbiddenError("That sticker belongs to a different server");
  }
}

export async function listChannelMessages(params: {
  userId: string;
  channelId: string;
  before?: string;
  limit?: string;
}): Promise<MessageDTO[]> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId } });
  if (!channel) throw new NotFoundError("Channel not found");

  await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.VIEW_CHANNELS);

  const cursor = parseCursor(params.before);
  const limit = parseLimit(params.limit);

  const messages = await prisma.message.findMany({
    where: {
      channelId: params.channelId,
      deletedAt: null,
      ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
    include: messageInclude,
  });

  return messages.map((m) => serializeMessage(m, params.userId));
}

export async function listDMMessages(params: {
  userId: string;
  conversationId: string;
  before?: string;
  limit?: string;
}): Promise<MessageDTO[]> {
  const participant = await prisma.dMParticipant.findUnique({
    where: { conversationId_userId: { conversationId: params.conversationId, userId: params.userId } },
  });
  if (!participant) throw new ForbiddenError("Not a participant in this conversation");

  const cursor = parseCursor(params.before);
  const limit = parseLimit(params.limit);

  const messages = await prisma.message.findMany({
    where: {
      dmConversationId: params.conversationId,
      deletedAt: null,
      ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
    include: messageInclude,
  });

  return messages.map((m) => serializeMessage(m, params.userId));
}

/** Slowmode (Channel.slowmodeSeconds, set via ChannelSettingsModal) — MANAGE_MESSAGES bypasses
 * it, matching Discord's own moderator exemption. Reuses checkPermission (which already knows
 * owner/ADMINISTRATOR bypass) rather than re-deriving the effective bitfield here. */
async function assertSlowmodeOk(userId: string, channelId: string, serverId: string, slowmodeSeconds: number): Promise<void> {
  if (slowmodeSeconds <= 0) return;
  try {
    await checkChannelPermission(userId, serverId, channelId, Permissions.MANAGE_MESSAGES);
    return;
  } catch {
    /* not exempt, fall through to the actual check */
  }
  const last = await prisma.message.findFirst({
    where: { channelId, authorId: userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return;
  const elapsedMs = Date.now() - last.createdAt.getTime();
  const remainingMs = slowmodeSeconds * 1000 - elapsedMs;
  if (remainingMs > 0) {
    throw new TooManyRequestsError(`Slow mode is on — wait ${Math.ceil(remainingMs / 1000)}s before sending another message`);
  }
}

export async function createChannelMessage(params: {
  userId: string;
  channelId: string;
  content: string;
  replyToId?: string | null;
  attachments?: CreateMessageAttachmentInput[];
  stickerId?: string | null;
  pollId?: string | null;
}): Promise<MessageDTO> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId } });
  if (!channel) throw new NotFoundError("Channel not found");

  await assertNotMuted(params.userId, channel.serverId);
  await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.SEND_MESSAGES);
  // Server verification gate. After the permission check (so a 403 for "you cannot post here" wins
  // over "verify your email", which is the more useful error) and before anything is written.
  await assertPassesVerification(params.userId, channel.serverId);
  await assertSlowmodeOk(params.userId, params.channelId, channel.serverId, channel.slowmodeSeconds);
  assertHasContent(params.content, params.attachments, params);
  if (params.stickerId) await assertStickerUsable(params.stickerId, channel.serverId);

  // AutoMod, at the same point as slowmode: after permission and content checks, before anything is
  // written. A rule that blocks a message must block it, not delete it a moment later — the
  // difference is whether it ever appeared in anyone's client, and the socket broadcast below is
  // what makes that irreversible.
  //
  // Returns immediately when the server has no rules, which is the overwhelming majority of sends,
  // and the rule set is Redis-cached so this is not a query per message.
  {
    const membership = await prisma.membership.findUnique({
      // `userId_serverId`, matching the @@unique field order — same key assertNotMuted uses above.
      where: { userId_serverId: { userId: params.userId, serverId: channel.serverId } },
      select: { roles: { select: { roleId: true } } },
    });
    await assertPassesAutoMod({
      serverId: channel.serverId,
      content: params.content,
      memberRoleIds: membership?.roles.map((r) => r.roleId) ?? [],
    });
  }

  if (params.attachments?.length) {
    await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.ATTACH_FILES);
  }

  const message = await prisma.message.create({
    data: {
      channelId: params.channelId,
      authorId: params.userId,
      content: params.content,
      replyToId: params.replyToId ? BigInt(params.replyToId) : null,
      stickerId: params.stickerId ?? null,
      pollId: params.pollId ?? null,
      attachments: params.attachments?.length
        ? {
            create: params.attachments.map((a) => ({
              ...(a.id ? { id: a.id } : {}),
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              url: a.url,
              width: a.width ?? null,
              height: a.height ?? null,
            })),
          }
        : undefined,
    },
    include: messageInclude,
  });

  const dto = serializeMessage(message, null);
  getIO().to(`channel:${params.channelId}`).emit(ServerEvents.MESSAGE_CREATE, dto);
  // Out-of-band, never awaited, and never in the send path — see lib/linkPreview.ts. Unfurling a
  // link means this server makes an outbound request to a URL a user chose; doing that before the
  // message is stored would let anyone make their own send hang for as long as a remote host cares
  // to stall.
  scheduleLinkPreviews({ messageId: message.id, content: params.content, room: `channel:${params.channelId}` });
  await syncMessageMentions({
    messageId: message.id,
    serverId: channel.serverId,
    channelId: params.channelId,
    authorId: params.userId,
    content: params.content,
    dto,
  });

  // Installed addons run here, deliberately AFTER the message exists and has been broadcast, and
  // deliberately not awaited. An automation must never be able to make someone's message slower to
  // send or able to fail — see modules/addons/runtime.ts, which also holds the loop guard (bot and
  // webhook messages trigger nothing) and the per-server action budget.
  void runMessageAutomations({
    messageId: message.id,
    channelId: params.channelId,
    channelName: channel.name,
    serverId: channel.serverId,
    authorId: params.userId,
    authorIsBot: message.author?.isBot ?? false,
    isWebhook: message.webhookId !== null,
    content: params.content,
  }).catch(() => {
    /* an addon failing is never the sender's problem */
  });

  return dto;
}

export async function createDMMessage(params: {
  userId: string;
  conversationId: string;
  content: string;
  replyToId?: string | null;
  attachments?: CreateMessageAttachmentInput[];
  stickerId?: string | null;
  pollId?: string | null;
}): Promise<MessageDTO> {
  const participant = await prisma.dMParticipant.findUnique({
    where: { conversationId_userId: { conversationId: params.conversationId, userId: params.userId } },
  });
  if (!participant) throw new ForbiddenError("Not a participant in this conversation");
  assertHasContent(params.content, params.attachments, params);
  // Stickers are server-scoped, and a DM has no server to scope against — the same reason a
  // `:name:` custom emoji cannot resolve in a DM. Rejected explicitly so the error says why.
  if (params.stickerId) throw new BadRequestError("Stickers can only be sent in a server");

  const message = await prisma.message.create({
    data: {
      dmConversationId: params.conversationId,
      authorId: params.userId,
      content: params.content,
      replyToId: params.replyToId ? BigInt(params.replyToId) : null,
      pollId: params.pollId ?? null,
      attachments: params.attachments?.length
        ? {
            create: params.attachments.map((a) => ({
              ...(a.id ? { id: a.id } : {}),
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              url: a.url,
              width: a.width ?? null,
              height: a.height ?? null,
            })),
          }
        : undefined,
    },
    include: messageInclude,
  });

  const dto = serializeMessage(message, null);
  getIO().to(`dm:${params.conversationId}`).emit(ServerEvents.MESSAGE_CREATE, dto);
  scheduleLinkPreviews({ messageId: message.id, content: params.content, room: `dm:${params.conversationId}` });

  const otherParticipants = await prisma.dMParticipant.findMany({
    where: { conversationId: params.conversationId, userId: { not: params.userId } },
    select: { userId: true },
  });
  const authorName = dto.author?.displayName ?? dto.author?.username ?? "Someone";
  for (const p of otherParticipants) {
    void sendPushToUser(p.userId, {
      title: authorName,
      body: params.content.slice(0, 150) || "Sent an attachment",
      url: `/dm/${params.conversationId}`,
      tag: `dm-${params.conversationId}`,
    });
  }
  return dto;
}

async function loadMessageOrThrow(messageId: string) {
  const message = await prisma.message.findUnique({
    where: { id: BigInt(messageId) },
    include: { channel: true, ...messageInclude },
  });
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  return message;
}

export async function editMessage(params: { userId: string; messageId: string; content: string }): Promise<MessageDTO> {
  const message = await loadMessageOrThrow(params.messageId);

  if (message.authorId !== params.userId) {
    if (message.channelId && message.channel) {
      await checkChannelPermission(params.userId, message.channel.serverId, message.channelId, Permissions.MANAGE_MESSAGES);
    } else {
      throw new ForbiddenError("Only the author can edit this message");
    }
  }

  if (!params.content.trim()) throw new BadRequestError("Message content cannot be empty");

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { content: params.content, editedAt: new Date() },
    include: messageInclude,
  });

  const dto = serializeMessage(updated, null);
  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmConversationId}`;
  getIO().to(room).emit(ServerEvents.MESSAGE_UPDATE, dto);
  if (message.channelId && message.channel) {
    // Re-scan on edit too (mentions can be added or removed); attributed to the original
    // author regardless of who made the edit, so a moderator editing someone else's message
    // can't use it to grant themselves an @everyone they don't have permission for.
    await syncMessageMentions({
      messageId: message.id,
      serverId: message.channel.serverId,
      channelId: message.channelId,
      authorId: message.authorId!,
      content: params.content,
      dto,
    });
  }
  return dto;
}

export async function deleteMessage(params: { userId: string; messageId: string }): Promise<{ id: string }> {
  const message = await loadMessageOrThrow(params.messageId);

  if (message.authorId !== params.userId) {
    if (message.channelId && message.channel) {
      await checkChannelPermission(params.userId, message.channel.serverId, message.channelId, Permissions.MANAGE_MESSAGES);
    } else {
      throw new ForbiddenError("Only the author can delete this message");
    }
  }

  await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });

  const payload = { id: params.messageId };
  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmConversationId}`;
  getIO().to(room).emit(ServerEvents.MESSAGE_DELETE, payload);
  return payload;
}

export interface ReactionBroadcast {
  messageId: string;
  emoji: string;
  userId: string;
  count: number;
}

export async function addReaction(params: { userId: string; messageId: string; emoji: string }): Promise<ReactionBroadcast> {
  const message = await loadMessageOrThrow(params.messageId);

  if (message.channelId && message.channel) {
    await checkChannelPermission(params.userId, message.channel.serverId, message.channelId, Permissions.ADD_REACTIONS);
  } else if (!message.dmConversationId) {
    throw new NotFoundError("Message not found");
  } else {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.dmConversationId, userId: params.userId } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");
  }

  await prisma.reaction.upsert({
    where: { messageId_userId_emoji: { messageId: message.id, userId: params.userId, emoji: params.emoji } },
    create: { messageId: message.id, userId: params.userId, emoji: params.emoji },
    update: {},
  });

  const count = await prisma.reaction.count({ where: { messageId: message.id, emoji: params.emoji } });
  const payload: ReactionBroadcast = { messageId: params.messageId, emoji: params.emoji, userId: params.userId, count };

  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmConversationId}`;
  getIO().to(room).emit(ServerEvents.REACTION_ADD, payload);
  return payload;
}

export async function removeReaction(params: { userId: string; messageId: string; emoji: string }): Promise<ReactionBroadcast> {
  const message = await loadMessageOrThrow(params.messageId);

  if (!message.channelId && message.dmConversationId) {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.dmConversationId, userId: params.userId } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");
  }

  await prisma.reaction
    .delete({
      where: { messageId_userId_emoji: { messageId: message.id, userId: params.userId, emoji: params.emoji } },
    })
    .catch(() => undefined);

  const count = await prisma.reaction.count({ where: { messageId: message.id, emoji: params.emoji } });
  const payload: ReactionBroadcast = { messageId: params.messageId, emoji: params.emoji, userId: params.userId, count };

  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmConversationId}`;
  getIO().to(room).emit(ServerEvents.REACTION_REMOVE, payload);
  return payload;
}

/**
 * Backs the mobile Activity feed (components/layout/AppShell.tsx's ActivityPlaceholder used to
 * be the entire implementation of this feature — it just said "coming soon"). Matches any
 * MessageMention row addressed to this user: directly, via a role they currently hold, or an
 * @everyone in a server they're currently a member of.
 */
export async function listMyMentions(userId: string, limit = 30): Promise<MentionFeedItemDTO[]> {
  const [myRoleAssignments, myMemberships] = await Promise.all([
    prisma.roleAssignment.findMany({ where: { membership: { userId } }, select: { roleId: true } }),
    prisma.membership.findMany({ where: { userId }, select: { serverId: true } }),
  ]);
  const myRoleIds = myRoleAssignments.map((r) => r.roleId);
  const myServerIds = myMemberships.map((m) => m.serverId);

  const mentions = await prisma.messageMention.findMany({
    where: {
      OR: [
        { userId },
        ...(myRoleIds.length ? [{ roleId: { in: myRoleIds } }] : []),
        ...(myServerIds.length ? [{ everyone: true, message: { channel: { serverId: { in: myServerIds } } } }] : []),
      ],
      message: { deletedAt: null },
    },
    include: {
      message: {
        include: {
          ...messageInclude,
          channel: { select: { id: true, name: true, serverId: true, server: { select: { name: true } } } },
        },
      },
    },
    orderBy: { message: { id: "desc" } },
    take: limit,
  });

  // A single message can carry more than one MessageMention row addressed to this user (e.g.
  // both a direct @mention and an @everyone) — dedupe to one feed entry per message.
  const seen = new Set<string>();
  const items: MentionFeedItemDTO[] = [];
  for (const m of mentions) {
    if (!m.message.channel || seen.has(m.message.id.toString())) continue;
    seen.add(m.message.id.toString());
    items.push({
      id: m.id,
      message: serializeMessage(m.message, userId),
      serverId: m.message.channel.serverId,
      serverName: m.message.channel.server.name,
      channelId: m.message.channel.id,
      channelName: m.message.channel.name,
      createdAt: m.message.createdAt.toISOString(),
    });
  }
  return items;
}

/**
 * Pinning is a moderation action (MANAGE_MESSAGES), not author-gated like edit/delete — matches
 * the permission the `pinned` column and MessageDTO.pinned field were already sitting there for
 * (see packages/shared/src/types.ts) with zero call sites before this. DM messages have no pin
 * concept (no channel, no MANAGE_MESSAGES to check against), so this only applies to channel
 * messages.
 */
export async function togglePinMessage(params: { userId: string; messageId: string; pinned: boolean }): Promise<MessageDTO> {
  const message = await loadMessageOrThrow(params.messageId);
  if (!message.channelId || !message.channel) throw new BadRequestError("DM messages cannot be pinned");

  await checkChannelPermission(params.userId, message.channel.serverId, message.channelId, Permissions.MANAGE_MESSAGES);

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { pinned: params.pinned },
    include: messageInclude,
  });

  const dto = serializeMessage(updated, null);
  getIO().to(`channel:${message.channelId}`).emit(ServerEvents.MESSAGE_UPDATE, dto);
  return dto;
}

export async function listPinnedMessages(params: { userId: string; channelId: string }): Promise<MessageDTO[]> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId } });
  if (!channel) throw new NotFoundError("Channel not found");

  await checkChannelPermission(params.userId, channel.serverId, channel.id, Permissions.VIEW_CHANNELS);

  // Discord caps pins at 50 per channel and so does this — the difference is that Discord enforces
  // it on the way in. Here nothing stops a channel accumulating thousands of pins, and this query
  // joined every one of them with its author, attachments and reactions into a popover panel.
  const messages = await prisma.message.findMany({
    where: { channelId: params.channelId, pinned: true, deletedAt: null },
    orderBy: { id: "desc" },
    include: messageInclude,
    take: 100,
  });
  return messages.map((m) => serializeMessage(m, params.userId));
}

/**
 * Called only from modules/webhooks/service.ts, which owns token verification — by the time
 * this runs, the caller has already proven it holds a valid webhook token, so there's no
 * userId/permission check here at all (a webhook has no author identity to check permissions
 * against). Deliberately skips @mention parsing (see modules/messages/mentions.ts) — the
 * mention/@everyone-permission model is built entirely around a human/bot User's server roles,
 * and a webhook post has no such identity to attribute that check to.
 */
export async function createWebhookMessage(params: {
  webhookId: string;
  channelId: string;
  content: string;
  overrideUsername: string;
  overrideAvatarUrl: string | null;
}): Promise<MessageDTO> {
  assertHasContent(params.content);

  const message = await prisma.message.create({
    data: {
      channelId: params.channelId,
      webhookId: params.webhookId,
      overrideUsername: params.overrideUsername,
      overrideAvatarUrl: params.overrideAvatarUrl,
      content: params.content,
    },
    include: messageInclude,
  });

  const dto = serializeMessage(message, null);
  getIO().to(`channel:${params.channelId}`).emit(ServerEvents.MESSAGE_CREATE, dto);
  return dto;
}
