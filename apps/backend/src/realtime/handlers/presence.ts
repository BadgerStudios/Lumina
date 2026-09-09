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
 * Clear every presence counter. Called once, before the server accepts connections: at that
 * moment there are zero live sockets by definition, so anything still in Redis is a leak from a
 * previous life. Also self-heals drift that has already accumulated.
 */
export async function resetPresenceCounters(): Promise<void> {
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
