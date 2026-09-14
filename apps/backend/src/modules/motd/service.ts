import { prisma } from "../../db/prisma.js";

/**
 * The owner's message of the day.
 *
 * One active notice, shown to each member once on their first load of the day and then not again
 * until the next one. The rule has to satisfy two things at once that pull in opposite directions:
 * a notice published this morning should reach people today, not tomorrow, and a notice nobody has
 * changed should not reappear every time someone reloads.
 *
 * Hence two pieces of state per member rather than one. `motdSeenId` answers "have you seen THIS
 * notice", which is what makes a new one appear immediately; `motdSeenAt` answers "have you seen it
 * TODAY", which is what makes an unchanged one come back tomorrow. Either alone gets one of the two
 * cases wrong, and which one it gets wrong is not obvious until it is live.
 */

export interface MotdDTO {
  id: string;
  title: string | null;
  body: string;
  publishedAt: string;
}

/**
 * The start of the current day, in UTC.
 *
 * A single server-side boundary rather than per-member local midnight. Doing it properly would mean
 * storing everyone's timezone and trusting it; the cost of not doing so is that the notice returns
 * at 00:00 UTC rather than at each person's own midnight, which for a once-a-day notice nobody is
 * waiting on is a difference without a consequence.
 */
function startOfDayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The active notice, or null when the owner has not published one. */
export async function getActiveMotd(): Promise<MotdDTO | null> {
  const motd = await prisma.motd.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  if (!motd) return null;
  return { id: motd.id, title: motd.title, body: motd.body, publishedAt: motd.createdAt.toISOString() };
}

/**
 * The notice this member should be shown right now, or null.
 *
 * Null is the overwhelmingly common answer — every load after the first of the day — so this is one
 * indexed read and nothing else.
 */
export async function getMotdForUser(userId: string): Promise<MotdDTO | null> {
  const motd = await getActiveMotd();
  if (!motd) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { motdSeenId: true, motdSeenAt: true },
  });
  if (!user) return null;

  const isNewNotice = user.motdSeenId !== motd.id;
  const seenToday = user.motdSeenAt !== null && user.motdSeenAt >= startOfDayUtc();
  return isNewNotice || !seenToday ? motd : null;
}

/**
 * Record that a member has seen a notice.
 *
 * Takes the id the client actually displayed rather than re-reading the active one: if the owner
 * publishes a new notice in the moment between the read and the dismissal, marking the NEW one as
 * seen would silently swallow it for that person.
 */
export async function markMotdSeen(userId: string, motdId: string): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId },
    data: { motdSeenId: motdId, motdSeenAt: new Date() },
  });
}

/**
 * Publish a notice, retiring whatever was active.
 *
 * One transaction, so there is never an instant with two active notices — which `getActiveMotd`
 * would resolve by date anyway, but "resolved by a tiebreak" and "cannot happen" are different
 * guarantees and only one of them survives someone reading this later.
 */
export async function publishMotd(params: {
  title: string | null;
  body: string;
  authorId: string;
}): Promise<MotdDTO> {
  const motd = await prisma.$transaction(async (tx) => {
    await tx.motd.updateMany({ where: { active: true }, data: { active: false } });
    return tx.motd.create({
      data: { title: params.title, body: params.body, createdById: params.authorId },
    });
  });
  return { id: motd.id, title: motd.title, body: motd.body, publishedAt: motd.createdAt.toISOString() };
}

/** Take the current notice down without replacing it. Members simply stop seeing one. */
export async function retireMotd(): Promise<void> {
  await prisma.motd.updateMany({ where: { active: true }, data: { active: false } });
}

/** Recent notices, for the owner's own reference — what was said, when, and by whom. */
export async function listRecentMotds(limit = 20) {
  const rows = await prisma.motd.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { createdBy: { select: { id: true, username: true, displayName: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    title: m.title,
    body: m.body,
    active: m.active,
    publishedAt: m.createdAt.toISOString(),
    author: m.createdBy
      ? { id: m.createdBy.id, name: m.createdBy.displayName ?? m.createdBy.username }
      : null,
  }));
}
