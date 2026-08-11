import type { UnreadDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { NotFoundError } from "../../lib/errors.js";

/**
 * Backs the Signal panel (frontend components/layout/SignalPanel.tsx). Uses the
 * ChannelReadState model (apps/backend/prisma/schema.prisma), which existed in the schema but
 * had zero call sites before this — every read here goes through it for real rather than
 * approximating unread state from message timestamps.
 */

/** Upserts the caller's read position for a channel to that channel's current latest message.
 * A no-op if the channel has no messages yet (nothing to mark read). */
export async function markChannelRead(params: { userId: string; channelId: string }): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId }, select: { id: true } });
  if (!channel) throw new NotFoundError("Channel not found");

  const latest = await prisma.message.findFirst({
    where: { channelId: params.channelId, deletedAt: null },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (!latest) return;

  await prisma.channelReadState.upsert({
    where: { userId_channelId: { userId: params.userId, channelId: params.channelId } },
    create: { userId: params.userId, channelId: params.channelId, lastReadMessageId: latest.id, lastReadAt: new Date() },
    update: { lastReadMessageId: latest.id, lastReadAt: new Date() },
  });
}

/** Per-TEXT-channel unread counts for the caller within a server. A channel with no
 * ChannelReadState row is treated as fully unread (every non-deleted message counts) — matches
 * a user who has never opened the channel. Only channels with unreadCount > 0 are returned. */
export async function getServerUnread(params: { userId: string; serverId: string }): Promise<UnreadDTO[]> {
  const channels = await prisma.channel.findMany({
    where: { serverId: params.serverId, type: "TEXT" },
    select: { id: true },
  });
  if (channels.length === 0) return [];

  const readStates = await prisma.channelReadState.findMany({
    where: { userId: params.userId, channelId: { in: channels.map((c) => c.id) } },
    select: { channelId: true, lastReadMessageId: true },
  });
  const lastReadByChannel = new Map(readStates.map((r) => [r.channelId, r.lastReadMessageId]));

  const counts = await Promise.all(
    channels.map(async (c) => {
      const lastRead = lastReadByChannel.get(c.id) ?? null;
      const unreadCount = await prisma.message.count({
        where: {
          channelId: c.id,
          deletedAt: null,
          ...(lastRead !== null ? { id: { gt: lastRead } } : {}),
        },
      });
      return { channelId: c.id, unreadCount };
    }),
  );

  return counts.filter((c) => c.unreadCount > 0);
}
