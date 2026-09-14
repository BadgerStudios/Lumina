import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents } from "@lumina/shared";
import type { PresenceStatus } from "@lumina/shared";
import { redis } from "../../db/redis.js";
import { prisma } from "../../db/prisma.js";

const OFFLINE_DEBOUNCE_MS = 10_000;

// In-memory per-process debounce timers. The connection COUNT itself lives
// in Redis (correct across multiple backend instances); this timer map only
// coordinates the ~10s "still might reconnect" grace window on whichever
// instance happens to observe the last disconnect. Good enough for a single
// dev instance — a production multi-instance deployment would want this
// debounce coordinated through Redis too (e.g. SET NX + TTL), noted here as
// a known follow-up rather than solved in this milestone.
const pendingOffline = new Map<string, NodeJS.Timeout>();

function connKey(userId: string): string {
  return `presence:conn:${userId}`;
}

/**
 * How long a connection counter may sit untouched before Redis forgets it.
 *
 * The counter is incremented on connect and decremented on disconnect, but a backend that stops
 * never runs the disconnect half — every socket dies with the process and its increment is
 * stranded. Redis is a separate container that outlives the backend across every deploy, so the
 * counters only ever climbed. Worse, once a user's counter was stuck above zero, `INCR` never
 * returned 1 again and that person was never marked ONLINE — they looked offline to everyone
 * while genuinely connected.
 *
 * Two independent guards, either of which is sufficient: the sweep at boot below, and this TTL
 * refreshed on every connect and disconnect.
 */
const CONN_TTL_SECONDS = 6 * 60 * 60;

/**
 * Bring stored presence back in line with reality. Called once, before the server accepts
 * connections: at that moment there are zero live sockets BY DEFINITION, so anything claiming
 * otherwise is a leak from a previous life, and this cannot mark a connected user offline.
 *
 * Both halves matter and only the first was ever done. The Redis counters were cleared here, but
 * `User.presence` was written on connect and on disconnect and NOWHERE ELSE — and a process that
 * stops never runs the disconnect half. Every deploy therefore stranded everyone who was connected
 * at that moment as permanently ONLINE, and since the column is what the member list reads, they
 * stayed lit up in every space they belonged to until they happened to connect and disconnect
 * cleanly again. The count only ever went up.
 *
 * INVISIBLE is left alone: it is a stored choice rather than a live state, it already displays as
 * OFFLINE to everyone else, and keeping it is what makes it survive to the next sign-in.
 */
export async function resetPresenceAtBoot(): Promise<void> {
  let cursor = "0";
  let cleared = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "presence:conn:*", "COUNT", 500);
    cursor = next;
    if (keys.length) {
      await redis.del(...keys);
      cleared += keys.length;
    }
  } while (cursor !== "0");
  if (cleared) console.log(`presence: cleared ${cleared} stale connection counter(s) at boot`);

  // No broadcast: nothing is connected yet to hear one, and every client fetches current state on
  // connect anyway. Anyone genuinely present reconnects within seconds and is marked ONLINE again
  // by the ordinary connect path.
  const { count } = await prisma.user.updateMany({
    where: { presence: { in: ["ONLINE", "IDLE", "DND"] } },
    data: { presence: "OFFLINE" },
  });
  if (count) console.log(`presence: reset ${count} user(s) left ONLINE by the previous process`);
}

async function setPresenceAndBroadcast(io: SocketIOServer, userId: string, presence: PresenceStatus): Promise<void> {
  // updateMany, not update: `update` throws P2025 when the row is gone, and this runs from a
  // detached disconnect timer where that rejection is unhandled and kills the process. A user
  // deleted (or self-deleted) while holding an open socket therefore took the whole API down for
  // everyone — observed in production. A missing user is a normal race here, not an error.
  const { count } = await prisma.user.updateMany({ where: { id: userId }, data: { presence } });
  if (count === 0) return;

  // INVISIBLE is stored (so it survives reconnects) but never broadcast — everyone else, on every
  // room, sees plain OFFLINE. serializeUser applies the same map to REST reads.
  const publicPresence: PresenceStatus = presence === "INVISIBLE" ? "OFFLINE" : presence;
  const memberships = await prisma.membership.findMany({ where: { userId }, select: { serverId: true } });
  const payload = { userId, presence: publicPresence };
  for (const m of memberships) {
    io.to(`server:${m.serverId}`).emit(ServerEvents.PRESENCE_UPDATE, payload);
  }
  // Also notify the user's own other sessions / DM peers listening on their user room.
  io.to(`user:${userId}`).emit(ServerEvents.PRESENCE_UPDATE, payload);
}

/**
 * What to correct, given who is actually connected and what the column claims.
 *
 * Split out from the I/O so the rule itself can be tested: presence is the kind of thing where an
 * inverted condition marks every connected user offline, and that is not a bug you want to find in
 * production. Both directions are needed —
 *
 *   - marked online with no socket: the drift this whole file exists to stop, and
 *   - marked offline while holding one: the other half of the same fault. A connection counter
 *     stuck above zero means INCR never returns 1 again, so that person is never marked ONLINE and
 *     looks offline to everyone while genuinely connected.
 *
 * INVISIBLE is skipped in both directions. It is a choice, not an observation.
 */
export function planPresenceReconciliation(
  connected: ReadonlySet<string>,
  stored: ReadonlyArray<{ id: string; presence: PresenceStatus }>,
): { toOffline: string[]; toOnline: string[] } {
  const toOffline: string[] = [];
  const toOnline: string[] = [];
  for (const row of stored) {
    if (row.presence === "INVISIBLE") continue;
    const isConnected = connected.has(row.id);
    if (!isConnected && row.presence !== "OFFLINE") toOffline.push(row.id);
    else if (isConnected && row.presence === "OFFLINE") toOnline.push(row.id);
  }
  return { toOffline, toOnline };
}

/** How often stored presence is checked against the live socket table. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** A sane ceiling on one pass. Steady state after the boot reset is zero; a number anywhere near
 * this means something else is wrong, and it should be visible rather than silently expensive. */
const RECONCILE_MAX_ROWS = 1000;

async function reconcilePresenceOnce(io: SocketIOServer): Promise<void> {
  let sockets;
  try {
    sockets = await io.fetchSockets();
  } catch {
    return; // adapter not ready; the next pass will do it
  }
  const connectedIds = [
    ...new Set(sockets.map((s) => s.data?.userId).filter((v): v is string => typeof v === "string")),
  ];
  const connected = new Set(connectedIds);

  const stored = await prisma.user.findMany({
    where: {
      OR: [
        { presence: { in: ["ONLINE", "IDLE", "DND"] } },
        ...(connectedIds.length ? [{ id: { in: connectedIds }, presence: "OFFLINE" as const }] : []),
      ],
    },
    select: { id: true, presence: true },
    take: RECONCILE_MAX_ROWS,
  });

  const { toOffline, toOnline } = planPresenceReconciliation(connected, stored);
  if (toOffline.length === 0 && toOnline.length === 0) return;

  // Re-read the socket table immediately before writing. Someone can connect between the fetch
  // above and here, and marking a user who just arrived as offline is a worse bug than the drift
  // this is correcting.
  let nowConnected = connected;
  try {
    const fresh = await io.fetchSockets();
    nowConnected = new Set(
      fresh.map((s) => s.data?.userId).filter((v): v is string => typeof v === "string"),
    );
  } catch {
    /* keep the earlier snapshot */
  }

  for (const userId of toOffline) {
    if (nowConnected.has(userId)) continue;
    await setPresenceAndBroadcast(io, userId, "OFFLINE");
  }
  for (const userId of toOnline) {
    if (!nowConnected.has(userId)) continue;
    await setPresenceAndBroadcast(io, userId, "ONLINE");
  }
  console.log(
    `presence: reconciled ${toOffline.length} stale online, ${toOnline.length} missed online`,
  );
}

/**
 * Keeps the column honest while the process runs.
 *
 * The boot reset handles a process that stopped; this handles everything that goes wrong while one
 * is running — a decrement lost to a Redis blip, a counter stranded above zero, an instance that
 * went away in a multi-instance deployment (the offline debounce below is per-process and would
 * never fire for sockets it never owned). The live socket table is the one source that cannot
 * drift: if the connection is gone, the entry is gone. It is the same ground truth the owner
 * dashboard counts from.
 *
 * Unref'd so it can never be the reason the process stays alive.
 */
export function startPresenceReconciler(io: SocketIOServer): NodeJS.Timeout {
  const timer = setInterval(() => {
    void reconcilePresenceOnce(io).catch((err) => {
      console.error("presence: reconciliation failed", err);
    });
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
  return timer;
}

export async function registerPresenceHandlers(io: SocketIOServer, socket: Socket): Promise<void> {
  const userId = socket.data.userId as string;

  const pending = pendingOffline.get(userId);
  if (pending) {
    clearTimeout(pending);
    pendingOffline.delete(userId);
  }

  const count = await redis.incr(connKey(userId));
  await redis.expire(connKey(userId), CONN_TTL_SECONDS);
  if (count === 1) {
    // Coming online must not blow away a chosen invisibility: a user who set INVISIBLE and then
    // reconnects should stay invisible, not silently reappear as ONLINE.
    const existing = await prisma.user.findUnique({ where: { id: userId }, select: { presence: true } });
    await setPresenceAndBroadcast(io, userId, existing?.presence === "INVISIBLE" ? "INVISIBLE" : "ONLINE");
  }

  socket.on(ClientEvents.PRESENCE_SET, async (payload: { presence: "ONLINE" | "IDLE" | "DND" | "INVISIBLE" }) => {
    if (!["ONLINE", "IDLE", "DND", "INVISIBLE"].includes(payload?.presence)) return;
    await setPresenceAndBroadcast(io, userId, payload.presence);
  });
}

export async function handlePresenceDisconnect(io: SocketIOServer, socket: Socket): Promise<void> {
  const userId = socket.data.userId as string;
  if (!userId) return;

  const count = await redis.decr(connKey(userId));
  await redis.expire(connKey(userId), CONN_TTL_SECONDS);
  if (count <= 0) {
    await redis.set(connKey(userId), "0", "EX", CONN_TTL_SECONDS);

    const timeout = setTimeout(() => {
      void (async () => {
        pendingOffline.delete(userId);
        try {
          const current = await redis.get(connKey(userId));
          if (Number(current ?? "0") <= 0) {
            // Don't overwrite a deliberate INVISIBLE with OFFLINE on disconnect — others already see
            // them as offline, and keeping INVISIBLE stored is what makes it persist to next login.
            const existing = await prisma.user.findUnique({ where: { id: userId }, select: { presence: true } });
            if (existing?.presence !== "INVISIBLE") await setPresenceAndBroadcast(io, userId, "OFFLINE");
          }
        } catch (err) {
          // Belt and braces alongside the updateMany above: nothing that happens in a detached
          // timer, for one user's presence, is worth terminating the process for.
          console.error("presence: failed to mark user offline", userId, err);
        }
      })();
    }, OFFLINE_DEBOUNCE_MS);

    pendingOffline.set(userId, timeout);
  }
}
