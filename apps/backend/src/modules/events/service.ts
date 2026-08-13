import { prisma } from "../../db/prisma.js";
import { pushInboxNotification } from "../inbox/service.js";
import { sendPushToUser } from "../../lib/push.js";

/** How far ahead of start the reminder lands. Close enough to act on, far enough to finish
 * dinner first. */
const REMIND_AHEAD_MS = 30 * 60 * 1000;

export interface EventDTO {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  channelId: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string | null;
  canceledAt: string | null;
  creator: { id: string; username: string; displayName: string | null } | null;
  goingCount: number;
  interestedCount: number;
  myRsvp: "GOING" | "INTERESTED" | null;
}

type EventWithMeta = Awaited<ReturnType<typeof loadEvents>>[number];

function loadEvents(serverId: string) {
  return prisma.serverEvent.findMany({
    where: { serverId },
    include: {
      creator: { select: { id: true, username: true, displayName: true } },
      rsvps: { select: { userId: true, status: true } },
    },
    orderBy: { startsAt: "asc" },
  });
}

function serialize(event: EventWithMeta, viewerId: string): EventDTO {
  const mine = event.rsvps.find((r) => r.userId === viewerId);
  return {
    id: event.id,
    serverId: event.serverId,
    name: event.name,
    description: event.description,
    channelId: event.channelId,
    location: event.location,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt?.toISOString() ?? null,
    canceledAt: event.canceledAt?.toISOString() ?? null,
    creator: event.creator,
    goingCount: event.rsvps.filter((r) => r.status === "GOING").length,
    interestedCount: event.rsvps.filter((r) => r.status === "INTERESTED").length,
    myRsvp: mine?.status ?? null,
  };
}

/** Upcoming and in-progress events plus anything that ended in the last day (so "you just
 * missed it" is visible rather than the event silently vanishing at start time). */
export async function listServerEvents(serverId: string, viewerId: string): Promise<EventDTO[]> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await loadEvents(serverId);
  return events
    .filter((e) => (e.endsAt ?? e.startsAt) >= dayAgo)
    .map((e) => serialize(e, viewerId));
}

/**
 * Reminder sweep, run from the worker. remindedAt doubles as the idempotency claim: the
 * updateMany-with-null-predicate means two racing workers cannot both send — the same
 * race-in-the-predicate pattern the XP cooldown uses.
 */
export async function sweepEventReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + REMIND_AHEAD_MS);
  const due = await prisma.serverEvent.findMany({
    where: { remindedAt: null, canceledAt: null, startsAt: { gt: now, lte: soon } },
    include: {
      rsvps: { select: { userId: true } },
      server: { select: { name: true } },
    },
  });

  let reminded = 0;
  for (const event of due) {
    const claimed = await prisma.serverEvent.updateMany({
      where: { id: event.id, remindedAt: null },
      data: { remindedAt: now },
    });
    if (claimed.count === 0) continue;

    const minutes = Math.max(1, Math.round((event.startsAt.getTime() - now.getTime()) / 60000));
    for (const { userId } of event.rsvps) {
      await pushInboxNotification({
        userId,
        kind: "EVENT_REMINDER",
        bundleKey: `EVENT_REMINDER:${event.id}`,
        serverId: event.serverId,
        preview: `${event.name} starts in about ${minutes} min — ${event.server.name}`,
      }).catch(() => undefined);
      sendPushToUser(userId, {
        title: event.server.name,
        body: `${event.name} starts in about ${minutes} minutes`,
        url: `/servers/${event.serverId}`,
        tag: `event:${event.id}`,
      }).catch(() => undefined);
    }
    reminded++;
  }
  return reminded;
}
