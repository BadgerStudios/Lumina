import type { Server as SocketIOServer } from "socket.io";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../db/prisma.js";
import { redis } from "../db/redis.js";
import { sendPushToUser } from "../lib/push.js";
import { serializeMessage } from "../lib/serialize.js";
import { messageInclude } from "../modules/messages/service.js";
import { getIO } from "./io.js";

/**
 * What happens to a DM call ring after it goes out: answered, declined, or never picked up.
 *
 * A ring used to be fire-and-forget. If nobody answered, nothing recorded it: the person called
 * came back to a conversation with no sign anyone had tried to reach them. Now every ring is
 * remembered for as long as it rings (Redis, so any backend instance can settle it) and ends
 * exactly one way:
 *
 * - answered: someone other than the caller joins the call. Nothing is posted.
 * - declined: a person called declines, in the app or from the phone's notification. A line in the
 *   conversation says so, so the caller knows.
 * - missed: the caller hangs up first, or RING_MS passes with no answer. A "Missed call" line is
 *   posted and the people called get a missed-call notification.
 *
 * GETDEL makes the ending atomic: when two endings race (a decline arriving as the timer fires),
 * exactly one of them finds the ring and posts.
 */
export const RING_MS = 60_000;
const ringKey = (conversationId: string) => `call:ring:${conversationId}`;
const timers = new Map<string, NodeJS.Timeout>();

interface Ring {
  callerId: string;
  callerName: string;
  startedAt: number;
}

function parseRing(raw: string | null): Ring | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Ring;
    return typeof r?.callerId === "string" ? r : null;
  } catch {
    return null;
  }
}

function clearTimer(conversationId: string): void {
  const t = timers.get(conversationId);
  if (t) clearTimeout(t);
  timers.delete(conversationId);
}

export async function participantsOf(conversationId: string): Promise<string[]> {
  const rows = await prisma.dMParticipant.findMany({ where: { conversationId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/**
 * Take a ring back from phones. A phone rings on its own until told to stop (android CallRinger),
 * so every way a ring ends in the app — the caller hangs up, someone answers, someone declines —
 * has to reach the phones as well. Forced past the "active on a desktop" rule: that rule decides
 * whether to ring, and a ring that already went out must always be stoppable. Harmless where
 * nothing is ringing.
 */
export function cancelRingPush(conversationId: string, userIds: string[]): void {
  for (const uid of new Set(userIds)) {
    void sendPushToUser(uid, {
      title: "",
      body: "",
      url: `/dm/${conversationId}`,
      tag: `call-${conversationId}`,
      kind: "direct",
      ttlSeconds: 60,
      force: true,
      call: { phase: "cancel", conversationId, callerName: "" },
    }).catch(() => undefined);
  }
}

/** A ring went out. Starts (or restarts, on a re-ring) the clock that turns it into a missed call. */
export async function ringStarted(conversationId: string, callerId: string, callerName: string): Promise<void> {
  const ring: Ring = { callerId, callerName, startedAt: Date.now() };
  await redis.set(ringKey(conversationId), JSON.stringify(ring), "PX", RING_MS + 15_000);
  clearTimer(conversationId);
  const timer = setTimeout(() => {
    timers.delete(conversationId);
    void ringEnded(conversationId, { kind: "missed" }).catch((err) => console.error("[calls] missed-call timeout failed:", err));
  }, RING_MS);
  timer.unref();
  timers.set(conversationId, timer);
}

/** Someone joined the call. Only an answer when it is not the caller (re)joining their own call. */
export async function ringAnswered(conversationId: string, userId: string): Promise<void> {
  const ring = parseRing(await redis.get(ringKey(conversationId)));
  if (!ring || ring.callerId === userId) return;
  await redis.del(ringKey(conversationId));
  clearTimer(conversationId);
}

type Ending = { kind: "missed" } | { kind: "declined"; byUserId: string };

/** End a ring that nobody answered. A no-op when it was already answered or ended. */
export async function ringEnded(conversationId: string, ending: Ending): Promise<void> {
  clearTimer(conversationId);
  const ring = parseRing(await redis.getdel(ringKey(conversationId)));
  if (!ring) return;
  const io = getIO();
  if (ending.kind === "missed") {
    // The caller gave up or nobody picked up: every phone still ringing must stop.
    io.to(`dm:${conversationId}`).emit(ServerEvents.CALL_ENDED, { conversationId });
    cancelRingPush(conversationId, await participantsOf(conversationId));
    await postCallLine(conversationId, ring.callerId, `Missed call from ${ring.callerName}`);
    const called = await prisma.dMParticipant.findMany({
      where: { conversationId, userId: { not: ring.callerId }, muted: false },
      select: { userId: true },
    });
    for (const p of called) {
      void sendPushToUser(p.userId, {
        title: ring.callerName,
        body: "Missed call",
        url: `/dm/${conversationId}`,
        tag: `missed-call-${conversationId}`,
        kind: "direct",
        force: true,
      }).catch(() => undefined);
    }
    return;
  }
  const decliner = await prisma.user.findUnique({ where: { id: ending.byUserId }, select: { displayName: true, username: true } });
  const name = decliner?.displayName ?? decliner?.username ?? "Someone";
  await postCallLine(conversationId, ending.byUserId, `${name} declined a call from ${ring.callerName}`);
}

async function postCallLine(conversationId: string, authorId: string, content: string): Promise<void> {
  const message = await prisma.message.create({
    data: { dmConversationId: conversationId, authorId, content, type: "CALL" },
    include: messageInclude,
  });
  // Resurface the conversation for anyone who had closed it, the same as any new DM message.
  await prisma.dMParticipant.updateMany({ where: { conversationId, hidden: true }, data: { hidden: false } });
  getIO().to(`dm:${conversationId}`).emit(ServerEvents.MESSAGE_CREATE, serializeMessage(message, null, null));
}

/**
 * Decline a ring, from the app (CALL_DECLINE) or a phone's notification (POST /api/voice/calls/decline).
 * Returns false when the person is not in the conversation.
 */
export async function declineCall(io: SocketIOServer, conversationId: string, userId: string): Promise<boolean> {
  const me = await prisma.dMParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true },
  });
  if (!me) return false;
  io.to(`dm:${conversationId}`).emit(ServerEvents.CALL_ENDED, { conversationId });
  cancelRingPush(conversationId, await participantsOf(conversationId));
  await ringEnded(conversationId, { kind: "declined", byUserId: userId });
  return true;
}
