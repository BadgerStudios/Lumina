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

async function setPresenceAndBroadcast(io: SocketIOServer, userId: string, presence: PresenceStatus): Promise<void> {
  // updateMany, not update: `update` throws P2025 when the row is gone, and this runs from a
  // detached disconnect timer where that rejection is unhandled and kills the process. A user
  // deleted (or self-deleted) while holding an open socket therefore took the whole API down for
  // everyone — observed in production. A missing user is a normal race here, not an error.
  const { count } = await prisma.user.updateMany({ where: { id: userId }, data: { presence } });
  if (count === 0) return;

  const memberships = await prisma.membership.findMany({ where: { userId }, select: { serverId: true } });
  const payload = { userId, presence };
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
  if (count === 1) {
    await setPresenceAndBroadcast(io, userId, "ONLINE");
  }

  socket.on(ClientEvents.PRESENCE_SET, async (payload: { presence: "ONLINE" | "IDLE" | "DND" }) => {
    if (!["ONLINE", "IDLE", "DND"].includes(payload?.presence)) return;
    await setPresenceAndBroadcast(io, userId, payload.presence);
  });
}

export async function handlePresenceDisconnect(io: SocketIOServer, socket: Socket): Promise<void> {
  const userId = socket.data.userId as string;
  if (!userId) return;

  const count = await redis.decr(connKey(userId));
  if (count <= 0) {
    await redis.set(connKey(userId), "0");

    const timeout = setTimeout(() => {
      void (async () => {
        pendingOffline.delete(userId);
        try {
          const current = await redis.get(connKey(userId));
          if (Number(current ?? "0") <= 0) {
            await setPresenceAndBroadcast(io, userId, "OFFLINE");
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
