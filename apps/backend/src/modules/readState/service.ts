import type { UnreadDTO, ServerUnreadSummaryDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { filterVisibleChannels } from "../../permissions/permissionService.js";

/**
 * Backs the Signal panel (frontend components/layout/SignalPanel.tsx). Uses the
 * ChannelReadState model (apps/backend/prisma/schema.prisma), which existed in the schema but
 * had zero call sites before this — every read here goes through it for real rather than
 * approximating unread state from message timestamps.
 */

/** Upserts the caller's read position for a channel to that channel's current latest message.
 * The write is a no-op if the channel has no messages yet.
 *
 * Returns the read position as it stood *immediately before* this call, which is exactly where the
 * "new messages" divider belongs for the client that just opened the channel — everything after it
 * is unseen. Returning it from here is what makes the divider race-free: the boundary is captured
 * in the same call that clears the unread, so there is no window in which a separate cursor fetch
 * could come back with the already-advanced position. */
export async function markChannelRead(params: {
  userId: string;
  channelId: string;
}): Promise<{ previousLastReadMessageId: string | null }> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId }, select: { id: true } });
  if (!channel) throw new NotFoundError("Channel not found");

  const existing = await prisma.channelReadState.findUnique({
    where: { userId_channelId: { userId: params.userId, channelId: params.channelId } },
    select: { lastReadMessageId: true },
  });
  const previousLastReadMessageId =
    existing?.lastReadMessageId != null ? existing.lastReadMessageId.toString() : null;

  const latest = await prisma.message.findFirst({
    where: { channelId: params.channelId, deletedAt: null },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  if (!latest) return { previousLastReadMessageId };

  await prisma.channelReadState.upsert({
    where: { userId_channelId: { userId: params.userId, channelId: params.channelId } },
    create: { userId: params.userId, channelId: params.channelId, lastReadMessageId: latest.id, lastReadAt: new Date() },
    update: { lastReadMessageId: latest.id, lastReadAt: new Date() },
  });
  return { previousLastReadMessageId };
}

/** Marks a channel UNREAD from `messageId` onward: sets the caller's read position to the message
 * immediately before it (or null — fully unread — if there is none). The inverse of markChannelRead. */
export async function markChannelUnread(params: { userId: string; channelId: string; messageId: string }): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { id: params.channelId }, select: { id: true } });
  if (!channel) throw new NotFoundError("Channel not found");
  let messageId: bigint;
  try { messageId = BigInt(params.messageId); } catch { throw new BadRequestError("Invalid message id."); }
  const prev = await prisma.message.findFirst({
    where: { channelId: params.channelId, deletedAt: null, id: { lt: messageId } },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  await prisma.channelReadState.upsert({
    where: { userId_channelId: { userId: params.userId, channelId: params.channelId } },
    create: { userId: params.userId, channelId: params.channelId, lastReadMessageId: prev?.id ?? null, lastReadAt: new Date() },
    update: { lastReadMessageId: prev?.id ?? null, lastReadAt: new Date() },
  });
}

/** Marks every text channel in a server read up to its latest message — the "mark space as read"
 * action. A channel with no messages is skipped. Unlike markChannelRead it never needs the
 * pre-read cursor, because nothing anchors an unread divider off a bulk mark. */
export async function markServerRead(params: { userId: string; serverId: string }): Promise<void> {
  const channels = await prisma.channel.findMany({
    where: { serverId: params.serverId, type: "TEXT" },
    select: { id: true },
  });
  await Promise.all(
    channels.map(async (c) => {
      const latest = await prisma.message.findFirst({
        where: { channelId: c.id, deletedAt: null },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      if (!latest) return;
      await prisma.channelReadState.upsert({
        where: { userId_channelId: { userId: params.userId, channelId: c.id } },
        create: { userId: params.userId, channelId: c.id, lastReadMessageId: latest.id, lastReadAt: new Date() },
        update: { lastReadMessageId: latest.id, lastReadAt: new Date() },
      });
    }),
  );
}

/** Per-TEXT-channel unread counts for the caller within a server. A channel with no
 * ChannelReadState row is treated as fully unread (every non-deleted message counts) — matches
 * a user who has never opened the channel. Only channels with unreadCount > 0 are returned. */
export async function getServerUnread(params: { userId: string; serverId: string }): Promise<UnreadDTO[]> {
  const allChannels = await prisma.channel.findMany({
    where: { serverId: params.serverId, type: "TEXT" },
    select: { id: true },
  });
  if (allChannels.length === 0) return [];
  // Only count channels the caller can actually VIEW. Otherwise a private channel's
  // unread count leaks to a member who cannot open it. Uses the same helper the
  // sidebar channel list uses, so the two can never disagree about what is visible.
  const channels = await filterVisibleChannels(params.userId, params.serverId, allChannels);
  if (channels.length === 0) return [];

  // The caller's read positions and their roles in this server, in parallel: the roles decide
  // which @role mentions count as theirs in the mention pass below.
  const [readStates, membership] = await Promise.all([
    prisma.channelReadState.findMany({
      where: { userId: params.userId, channelId: { in: channels.map((c) => c.id) } },
      select: { channelId: true, lastReadMessageId: true },
    }),
    prisma.membership.findUnique({
      where: { userId_serverId: { userId: params.userId, serverId: params.serverId } },
      select: { roles: { select: { roleId: true } } },
    }),
  ]);
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

  // Unread mentions of the caller across the same channels. A message counts once no matter how
  // many ways it mentions them (a direct @ AND an @everyone is still one badge), never counts
  // their own message, and only counts while it sits past their read position in that channel.
  const channelIds = channels.map((c) => c.id);
  const myRoleIds = membership?.roles.map((r) => r.roleId) ?? [];
  const mentionRows = await prisma.messageMention.findMany({
    where: {
      message: { channelId: { in: channelIds }, deletedAt: null, authorId: { not: params.userId } },
      OR: [
        { userId: params.userId },
        ...(myRoleIds.length > 0 ? [{ roleId: { in: myRoleIds } }] : []),
        { everyone: true },
      ],
    },
    select: { messageId: true, message: { select: { channelId: true, id: true } } },
  });
  const mentionSets = new Map<string, Set<string>>();
  for (const row of mentionRows) {
    const chId = row.message.channelId;
    if (!chId) continue;
    const lastRead = lastReadByChannel.get(chId) ?? null;
    if (lastRead !== null && row.message.id <= lastRead) continue; // already read past this mention
    let set = mentionSets.get(chId);
    if (!set) {
      set = new Set();
      mentionSets.set(chId, set);
    }
    set.add(row.messageId.toString());
  }

  return counts
    .filter((c) => c.unreadCount > 0)
    .map((c) => ({ ...c, mentionCount: mentionSets.get(c.channelId)?.size ?? 0 }));
}

/** Rolled-up unread across every server the caller belongs to — one summary per server that has
 * any unread, so the space rail can show which spaces (including collapsed ones) have activity,
 * and which of them are actually addressed to this person. Reuses getServerUnread per membership,
 * which also means it inherits the VIEW_CHANNELS filter rather than re-deriving it. A user in very
 * many servers pays a query per server; that is acceptable for the rail and can be batched later
 * if it ever stops being. */
export async function getGlobalUnread(userId: string): Promise<ServerUnreadSummaryDTO[]> {
  const memberships = await prisma.membership.findMany({ where: { userId }, select: { serverId: true } });
  const summaries = await Promise.all(
    memberships.map(async (m) => {
      const perChannel = await getServerUnread({ userId, serverId: m.serverId });
      return {
        serverId: m.serverId,
        unreadCount: perChannel.reduce((sum, c) => sum + c.unreadCount, 0),
        mentionCount: perChannel.reduce((sum, c) => sum + c.mentionCount, 0),
      };
    }),
  );
  return summaries.filter((s) => s.unreadCount > 0);
}
