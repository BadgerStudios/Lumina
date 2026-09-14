import { prisma } from "../../db/prisma.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { sendPushToUser } from "../../lib/push.js";
import { serializeUser } from "../../lib/serialize.js";

/**
 * Things a person keeps: saved messages, reminders about them, and private notes on other accounts.
 *
 * Grouped as one module because they are the same instinct — "I will want this later" — and because
 * the reminder is a property of a save rather than a thing of its own. Without somewhere to put
 * that instinct people screenshot messages and leave, which is a retention hole disguised as a
 * missing button.
 */

/** Can this person actually see the message they are trying to save? */
async function assertCanSee(userId: string, messageId: bigint) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      deletedAt: true,
      dmConversationId: true,
      channel: { select: { serverId: true } },
    },
  });
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");

  // The same membership check the message itself was delivered under. Saving is a read, and a read
  // of something you were never allowed to see is exactly what this prevents — without it, any
  // message id would be retrievable through the saved list forever.
  if (message.channel?.serverId) {
    const member = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId: message.channel.serverId } },
    });
    if (!member) throw new NotFoundError("Message not found");
  } else if (message.dmConversationId) {
    const part = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.dmConversationId, userId } },
    });
    if (!part) throw new NotFoundError("Message not found");
  } else {
    throw new NotFoundError("Message not found");
  }
  return message;
}

export async function saveMessage(params: {
  userId: string;
  messageId: bigint;
  note?: string | null;
  remindAt?: Date | null;
}) {
  await assertCanSee(params.userId, params.messageId);
  if (params.remindAt && params.remindAt.getTime() < Date.now()) {
    throw new BadRequestError("That reminder time has already passed");
  }

  const data = {
    note: params.note?.slice(0, 500) ?? null,
    remindAt: params.remindAt ?? null,
    // Re-arming a reminder on an already-reminded save has to clear the old delivery, or the
    // sweeper would skip it as already done.
    remindedAt: null,
  };
  return prisma.savedMessage.upsert({
    where: { userId_messageId: { userId: params.userId, messageId: params.messageId } },
    create: { userId: params.userId, messageId: params.messageId, ...data },
    update: data,
  });
}

export async function unsaveMessage(userId: string, messageId: bigint) {
  await prisma.savedMessage.deleteMany({ where: { userId, messageId } });
}

export async function listSaved(userId: string, limit: number, cursor?: string) {
  const rows = await prisma.savedMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      message: {
        select: {
          id: true,
          content: true,
          createdAt: true,
          deletedAt: true,
          channelId: true,
          dmConversationId: true,
          author: true,
          channel: { select: { id: true, name: true, serverId: true, server: { select: { name: true } } } },
        },
      },
    },
  });

  const page = rows.slice(0, limit);
  return {
    saved: page.map((s) => ({
      id: s.id,
      note: s.note,
      remindAt: s.remindAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      message: {
        id: s.message.id.toString(),
        // A message deleted after it was saved keeps its row so the note survives, but its content
        // must not: the author retracted it, and a saved copy would quietly defeat that.
        content: s.message.deletedAt ? "" : s.message.content,
        deleted: s.message.deletedAt !== null,
        createdAt: s.message.createdAt.toISOString(),
        author: s.message.author ? serializeUser(s.message.author) : null,
        channelId: s.message.channelId,
        dmConversationId: s.message.dmConversationId,
        location: s.message.channel
          ? s.message.channel.server
            ? `${s.message.channel.server.name} · #${s.message.channel.name}`
            : `#${s.message.channel.name}`
          : "Direct message",
        serverId: s.message.channel?.serverId ?? null,
      },
    })),
    nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
  };
}

/**
 * Deliver reminders that have come due.
 *
 * Runs on an interval rather than a timer per reminder: a process restart forgets every in-memory
 * timer, and a reminder that silently never arrives is worse than one that arrives a minute late.
 * Each delivery nulls `remindAt` in the same update that stamps `remindedAt`, so a slow push cannot
 * cause the next sweep to send it twice.
 */
export async function sweepReminders(): Promise<number> {
  const due = await prisma.savedMessage.findMany({
    where: { remindAt: { lte: new Date() }, remindedAt: null },
    take: 200,
    include: {
      message: { select: { id: true, content: true, channelId: true, dmConversationId: true } },
    },
  });

  let sent = 0;
  for (const row of due) {
    const claimed = await prisma.savedMessage.updateMany({
      // The guard is what makes this safe to run in more than one process: whoever updates the row
      // first wins, and the loser's updateMany reports zero rows and skips the send.
      where: { id: row.id, remindedAt: null },
      data: { remindedAt: new Date(), remindAt: null },
    });
    if (claimed.count === 0) continue;

    const preview = row.message.content.slice(0, 120) || "a message";
    await sendPushToUser(row.userId, {
      title: "You asked to be reminded",
      body: row.note ? `${row.note} — ${preview}` : preview,
      url: row.message.channelId ? `/channels/${row.message.channelId}` : "/friends",
      tag: `reminder:${row.id}`,
    }).catch(() => {});
    sent += 1;
  }
  return sent;
}

let reminderTimer: NodeJS.Timeout | null = null;

/** Started once at boot. Unref'd so it never holds the process open during a shutdown. */
export function startReminderSweeper(intervalMs = 60_000): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    void sweepReminders().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[reminders] sweep failed:", (err as Error)?.message);
    });
  }, intervalMs);
  reminderTimer.unref?.();
}

// ── private notes ────────────────────────────────────────────────────────────

export async function getNote(authorId: string, subjectId: string) {
  const note = await prisma.userNote.findUnique({
    where: { authorId_subjectId: { authorId, subjectId } },
  });
  return note ? { body: note.body, updatedAt: note.updatedAt.toISOString() } : null;
}

export async function setNote(authorId: string, subjectId: string, body: string) {
  if (authorId === subjectId) throw new BadRequestError("You can't keep a note about yourself");
  const trimmed = body.trim().slice(0, 1000);
  // An emptied note is a deleted note. Keeping a blank row would make the profile show an empty
  // note section forever with no way to clear it.
  if (!trimmed) {
    await prisma.userNote.deleteMany({ where: { authorId, subjectId } });
    return null;
  }
  const saved = await prisma.userNote.upsert({
    where: { authorId_subjectId: { authorId, subjectId } },
    create: { authorId, subjectId, body: trimmed },
    update: { body: trimmed },
  });
  return { body: saved.body, updatedAt: saved.updatedAt.toISOString() };
}

// ── streaks ──────────────────────────────────────────────────────────────────

/** Today in UTC, as a date with no time — see the migration for why this is not a timestamp. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export interface Streak {
  days: number;
  best: number;
  /** True only on the visit that extended it, so the client can celebrate once rather than daily. */
  extendedToday: boolean;
}

/**
 * Record that someone showed up, and return where that leaves their streak.
 *
 * Idempotent within a day: called on every session start, and the second call of the day changes
 * nothing. A gap of exactly one day extends; anything longer starts again at one.
 */
export async function touchStreak(userId: string): Promise<Streak> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { streakDays: true, streakBest: true, streakDay: true },
  });
  if (!user) throw new NotFoundError("Account not found");

  const day = today();
  if (user.streakDay && daysBetween(user.streakDay, day) === 0) {
    return { days: user.streakDays, best: user.streakBest, extendedToday: false };
  }

  const consecutive = user.streakDay && daysBetween(user.streakDay, day) === 1;
  const days = consecutive ? user.streakDays + 1 : 1;
  const best = Math.max(days, user.streakBest);

  await prisma.user.update({
    where: { id: userId },
    data: { streakDays: days, streakBest: best, streakDay: day },
  });
  return { days, best, extendedToday: true };
}
