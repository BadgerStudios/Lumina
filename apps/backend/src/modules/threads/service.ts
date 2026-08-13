import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { checkChannelPermission } from "../../permissions/permissionService.js";

/**
 * Threads.
 *
 * A thread is a `Channel` row of type THREAD whose `parentId` points at the TEXT channel it lives
 * in. That single decision is what makes this module small: sending, editing, deleting, reacting,
 * pinning, searching, @mentioning, slowmode, attachments, read state and the `channel:<id>`
 * realtime room are all keyed on channelId and therefore already work inside a thread. Nothing
 * below re-implements any of them.
 *
 * What genuinely needs new code is only the things a thread has that a channel does not: an origin
 * message, an archive lifecycle, and explicit membership.
 */

/** Discord's ladder, in minutes: 1 hour, 1 day, 3 days, 1 week. */
export const AUTO_ARCHIVE_CHOICES = [60, 1440, 4320, 10080];

const MAX_ACTIVE_THREADS_PER_CHANNEL = 100;

async function loadParent(channelId: string) {
  const parent = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!parent) throw new NotFoundError("Channel not found");
  if (parent.type === "THREAD") {
    // Discord's rule, and worth keeping: nested threads make "which channel am I in" ambiguous for
    // every permission and read-state lookup that currently resolves exactly one level up.
    throw new BadRequestError("Cannot start a thread inside a thread");
  }
  if (parent.type !== "TEXT") throw new BadRequestError("Threads can only be started in text channels");
  return parent;
}

export async function createThread(params: {
  userId: string;
  channelId: string;
  name: string;
  autoArchiveMinutes?: number;
  originMessageId?: string;
}) {
  const parent = await loadParent(params.channelId);

  // SEND_MESSAGES in the parent, not MANAGE_CHANNELS: starting a thread is participating in the
  // conversation, not administering the server. Resolved against the parent's overwrites, so a
  // member who cannot post in the channel cannot open a thread off it either.
  await checkChannelPermission(params.userId, parent.serverId, parent.id, Permissions.SEND_MESSAGES);

  if (params.autoArchiveMinutes !== undefined && !AUTO_ARCHIVE_CHOICES.includes(params.autoArchiveMinutes)) {
    throw new BadRequestError("Invalid auto-archive duration");
  }

  const activeCount = await prisma.channel.count({
    where: { parentId: parent.id, type: "THREAD", archived: false },
  });
  if (activeCount >= MAX_ACTIVE_THREADS_PER_CHANNEL) {
    throw new BadRequestError("This channel has too many active threads. Archive some first.");
  }

  let originId: bigint | undefined;
  if (params.originMessageId) {
    const origin = await prisma.message.findUnique({
      where: { id: BigInt(params.originMessageId) },
      select: { id: true, channelId: true, deletedAt: true, thread: { select: { id: true } } },
    });
    if (!origin || origin.deletedAt) throw new NotFoundError("Message not found");
    if (origin.channelId !== parent.id) throw new BadRequestError("That message is not in this channel");
    // Idempotent rather than a 409: two people clicking "Create thread" on the same message a
    // moment apart both want to end up in the same thread, and telling the second one "conflict"
    // would be an error message about a situation that is entirely fine.
    if (origin.thread) return getThread(origin.thread.id, params.userId);
    originId = origin.id;
  }

  const thread = await prisma.channel.create({
    data: {
      serverId: parent.serverId,
      name: params.name.trim().slice(0, 100),
      type: "THREAD",
      parentId: parent.id,
      position: 0,
      autoArchiveMinutes: params.autoArchiveMinutes ?? 4320,
      lastActivityAt: new Date(),
      ...(originId !== undefined ? { threadOriginMessageId: originId } : {}),
      // The creator is a member from the start — they plainly want to hear about replies.
      threadMembers: { create: { userId: params.userId } },
    },
  });

  return getThread(thread.id, params.userId);
}

export async function getThread(threadId: string, userId: string) {
  const thread = await prisma.channel.findUnique({
    where: { id: threadId },
    include: { _count: { select: { messages: true, threadMembers: true } } },
  });
  if (!thread || thread.type !== "THREAD") throw new NotFoundError("Thread not found");

  // Resolves through the parent — see permissionSourceChannelId. A thread in a channel the user
  // cannot view answers 404, not 403.
  await checkChannelPermission(userId, thread.serverId, thread.id, Permissions.VIEW_CHANNELS);

  const joined = await prisma.threadMembership.findUnique({
    where: { channelId_userId: { channelId: thread.id, userId } },
    select: { userId: true },
  });

  return serializeThread(thread, Boolean(joined));
}

export function serializeThread(
  thread: {
    id: string;
    serverId: string;
    name: string;
    parentId: string | null;
    threadOriginMessageId: bigint | null;
    archived: boolean;
    archivedAt: Date | null;
    autoArchiveMinutes: number;
    lastActivityAt: Date | null;
    createdAt: Date;
    _count?: { messages: number; threadMembers: number };
  },
  joined: boolean,
) {
  return {
    id: thread.id,
    serverId: thread.serverId,
    name: thread.name,
    parentId: thread.parentId,
    originMessageId: thread.threadOriginMessageId?.toString() ?? null,
    archived: thread.archived,
    archivedAt: thread.archivedAt?.toISOString() ?? null,
    autoArchiveMinutes: thread.autoArchiveMinutes,
    lastActivityAt: thread.lastActivityAt?.toISOString() ?? null,
    createdAt: thread.createdAt.toISOString(),
    messageCount: thread._count?.messages ?? 0,
    memberCount: thread._count?.threadMembers ?? 0,
    joined,
  };
}

export async function listThreads(params: { userId: string; channelId: string; archived: boolean }) {
  const parent = await loadParent(params.channelId);
  await checkChannelPermission(params.userId, parent.serverId, parent.id, Permissions.VIEW_CHANNELS);

  const threads = await prisma.channel.findMany({
    where: { parentId: parent.id, type: "THREAD", archived: params.archived },
    include: { _count: { select: { messages: true, threadMembers: true } } },
    orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
    take: 100,
  });

  const joined = await prisma.threadMembership.findMany({
    where: { userId: params.userId, channelId: { in: threads.map((t) => t.id) } },
    select: { channelId: true },
  });
  const joinedIds = new Set(joined.map((j) => j.channelId));

  return threads.map((t) => serializeThread(t, joinedIds.has(t.id)));
}

export async function setThreadMembership(threadId: string, userId: string, join: boolean) {
  const thread = await prisma.channel.findUnique({ where: { id: threadId }, select: { type: true, serverId: true } });
  if (!thread || thread.type !== "THREAD") throw new NotFoundError("Thread not found");
  await checkChannelPermission(userId, thread.serverId, threadId, Permissions.VIEW_CHANNELS);

  if (join) {
    await prisma.threadMembership.upsert({
      where: { channelId_userId: { channelId: threadId, userId } },
      create: { channelId: threadId, userId },
      update: {},
    });
  } else {
    await prisma.threadMembership.deleteMany({ where: { channelId: threadId, userId } });
  }
}

export async function setThreadArchived(threadId: string, userId: string, archived: boolean) {
  const thread = await prisma.channel.findUnique({
    where: { id: threadId },
    include: { _count: { select: { messages: true, threadMembers: true } } },
  });
  if (!thread || thread.type !== "THREAD") throw new NotFoundError("Thread not found");

  // Anyone who can post may unarchive (posting does it implicitly anyway — see
  // touchThreadActivity — so requiring a permission to do it explicitly would be inconsistent).
  // Archiving is the destructive-ish direction and needs MANAGE_MESSAGES, except for the person
  // who started the thread, who may always close their own.
  if (archived) {
    const isCreator = await prisma.threadMembership.findFirst({
      where: { channelId: threadId, userId },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
    if (isCreator?.userId !== userId) {
      await checkChannelPermission(userId, thread.serverId, threadId, Permissions.MANAGE_MESSAGES);
    }
  } else {
    await checkChannelPermission(userId, thread.serverId, threadId, Permissions.SEND_MESSAGES);
  }

  const updated = await prisma.channel.update({
    where: { id: threadId },
    data: { archived, archivedAt: archived ? new Date() : null, ...(archived ? {} : { lastActivityAt: new Date() }) },
    include: { _count: { select: { messages: true, threadMembers: true } } },
  });
  return serializeThread(updated, true);
}

/**
 * Called after a message lands in a channel. Cheap no-op for ordinary channels.
 *
 * Posting in an archived thread revives it, which is why this also clears `archived` rather than
 * only stamping the time — otherwise a reply would appear in a thread that the UI still lists as
 * archived, and the sweep would re-archive it on its next pass without anyone touching it.
 */
export async function touchThreadActivity(channelId: string): Promise<void> {
  await prisma.channel.updateMany({
    where: { id: channelId, type: "THREAD" },
    data: { lastActivityAt: new Date(), archived: false, archivedAt: null },
  });
}

/**
 * Archive every active thread whose inactivity has exceeded its own setting.
 *
 * Compared in SQL against each row's own `autoArchiveMinutes` rather than fetching and filtering
 * in JS: the whole point of the denormalised `lastActivityAt` is that this stays one statement
 * whose cost tracks thread count, not message volume.
 */
export async function sweepArchivableThreads(): Promise<number> {
  const result = await prisma.$executeRaw`
    UPDATE "Channel"
    SET "archived" = true, "archivedAt" = NOW()
    WHERE "type" = 'THREAD'
      AND "archived" = false
      AND COALESCE("lastActivityAt", "createdAt") < NOW() - ("autoArchiveMinutes" * INTERVAL '1 minute')
  `;
  return result;
}
