import type { NotificationKind } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { emitToRoom } from "../../realtime/emitBridge.js";
import { ServerEvents } from "@lumina/shared";

/**
 * The unified Activity inbox.
 *
 * Until now only @mentions, DMs and friend requests produced any signal — someone replying to
 * your message, reacting to it, or liking your video happened in silence. This module is the one
 * write path for "something happened to a thing that is yours", and its design constraint is the
 * inverse of most notification systems: it must stay QUIET enough to keep being read.
 *
 *  - **Bundling**: one row per (recipient, bundleKey); twenty reactions to one message are one
 *    row with actorCount 20, resurfaced (updatedAt) rather than repeated.
 *  - **Never about your own actions**: callers guard actor==recipient, and the service enforces
 *    it again, because a feed of your own activity is noise with your name on it.
 *  - **Fire-and-forget from hot paths**: message send must never wait on inbox writes, so every
 *    caller uses `.catch(() => undefined)` and a lost notification is an acceptable loss where a
 *    slow send is not.
 */
export async function pushInboxNotification(params: {
  userId: string;
  kind: NotificationKind;
  bundleKey: string;
  actorId?: string | null;
  messageId?: bigint | null;
  channelId?: string | null;
  serverId?: string | null;
  videoId?: string | null;
  preview?: string | null;
}): Promise<void> {
  if (params.actorId && params.actorId === params.userId) return;

  await prisma.notification.upsert({
    where: { userId_bundleKey: { userId: params.userId, bundleKey: params.bundleKey } },
    create: {
      userId: params.userId,
      kind: params.kind,
      bundleKey: params.bundleKey,
      actorId: params.actorId ?? null,
      messageId: params.messageId ?? null,
      channelId: params.channelId ?? null,
      serverId: params.serverId ?? null,
      videoId: params.videoId ?? null,
      preview: params.preview?.slice(0, 140) ?? null,
    },
    update: {
      // A bundle that gains an actor becomes unread again and shows the newest actor — "Alice
      // and 4 others reacted" — rather than staying buried under its own read state.
      actorId: params.actorId ?? undefined,
      actorCount: { increment: 1 },
      readAt: null,
      preview: params.preview?.slice(0, 140) ?? undefined,
    },
  });

  // Nudge, not payload: the client refetches its own inbox, the same privacy-preserving shape
  // CHANNEL_OVERWRITES_UPDATE uses. Works from the worker too via the Redis bridge.
  await emitToRoom(`user:${params.userId}`, ServerEvents.INBOX_NEW, {});
}

export async function listInbox(userId: string, before?: string) {
  return prisma.notification.findMany({
    where: { userId, ...(before ? { id: { lt: BigInt(before) } } : {}) },
    include: { actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
