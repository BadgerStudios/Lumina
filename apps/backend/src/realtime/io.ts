import { ServerEvents } from "@lumina/shared";
import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { redis, createRedisDuplicate } from "../db/redis.js";
import { resetPresenceAtBoot, startPresenceReconciler } from "./handlers/presence.js";
import { env } from "../config/env.js";
import { authenticateSocket } from "./middleware/authenticateSocket.js";
import { registerMessageHandlers } from "./handlers/message.js";
import { registerTypingHandlers } from "./handlers/typing.js";
import { registerPresenceHandlers, handlePresenceDisconnect } from "./handlers/presence.js";
import { registerChannelRoomHandlers } from "./handlers/channelRoom.js";
import { registerVoiceHandlers, handleVoiceDisconnect } from "./handlers/voice.js";
import { subscribeEmitBridge } from "./emitBridge.js";
import { setSocketConnections } from "../modules/metrics/prometheus.js";

let io: SocketIOServer | undefined;

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.IO server has not been initialized yet");
  return io;
}

/**
 * Force every live socket of `userId` out of a server's realtime rooms — the server room and all of
 * its channel rooms — after a kick or ban.
 *
 * Room membership is computed once at connect time (joinInitialRooms) and never revisited, so
 * without this a kicked/banned member's still-open socket keeps receiving that server's messages,
 * presence and member/role updates until it happens to reconnect. REST is already blocked on the
 * next request; this closes the realtime stream to match. socketsLeave runs cluster-wide through
 * the Redis adapter, so it reaches the target's sockets wherever they're connected. Best-effort and
 * swallowed: a moderation action must never fail because a realtime eviction hiccuped.
 */
/**
 * Is the person demonstrably looking at Lumina on a desktop or in a browser right now? That is the
 * one case a push is noise: they will see the message where they are. A phone in the foreground is
 * NOT counted — Android hands a push to the open app as an in-app toast, which is exactly right — and
 * a client that never reported activity (an older build) is not counted either, so it keeps its pushes.
 */
export async function userIsActive(userId: string): Promise<boolean> {
  if (!io) return false;
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    return sockets.some((s) => s.data.active === true && s.data.client !== "mobile");
  } catch {
    return false;
  }
}

/** Everyone with an active socket in a space, phones included — the people who are in the app and will see a channel light up on their own. */
export async function activeUserIdsInServer(serverId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!io) return out;
  try {
    for (const s of await io.in(`server:${serverId}`).fetchSockets()) {
      if (s.data.active === true && typeof s.data.userId === "string") out.add(s.data.userId);
    }
  } catch {
    // an adapter hiccup must not turn into "nobody is active": that just means a few extra pushes
  }
  return out;
}

export async function evictUserFromServer(userId: string, serverId: string): Promise<void> {
  if (!io) return;
  try {
    const { prisma } = await import("../db/prisma.js");
    const channels = await prisma.channel.findMany({ where: { serverId }, select: { id: true } });
    // Voice uses its own `voice:${channelId}` room namespace (handlers/voice.ts), separate from the
    // text `channel:` rooms — leave both, or a kicked/banned member stays in an active voice call,
    // still hearing and (since they remain a room member) still able to send signaling.
    const rooms = [`server:${serverId}`, ...channels.flatMap((c) => [`channel:${c.id}`, `voice:${c.id}`])];
    io.in(`user:${userId}`).socketsLeave(rooms);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[realtime] failed to evict user ${userId} from server ${serverId}:`, err);
  }
}

/**
 * Counterpart of evictUserFromServer. A user who was just added to a server gets their live
 * sockets into its room at once, plus a SERVER_JOINED nudge on their own room so anything that
 * translates the feed (the Discord compat gateway) can announce the guild and subscribe to its
 * channels. Without it a bot installed from the Bots panel sat deaf in the new space until its
 * next reconnect. Best-effort like the eviction: adding a member must not fail on realtime.
 */
export async function admitUserToServer(userId: string, serverId: string): Promise<void> {
  if (!io) return;
  try {
    io.in(`user:${userId}`).socketsJoin(`server:${serverId}`);
    io.to(`user:${userId}`).emit(ServerEvents.SERVER_JOINED, { serverId });
  } catch (err) {
    console.error(`[realtime] failed to admit user ${userId} to server ${serverId}:`, err);
  }
}

export function disconnectUser(userId: string): void {
  if (!io) return;
  try {
    io.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[realtime] failed to disconnect user ${userId} after ban:`, err);
  }
}

export async function initIO(httpServer: HTTPServer): Promise<SocketIOServer> {
  const origins = env.CORS_ORIGIN.split(",").map((s) => s.trim());

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: origins,
      credentials: true,
    },
  });

  // Before a single socket is accepted: anything claiming to be connected belongs to a process
  // that is no longer running.
  await resetPresenceAtBoot();

  const pubClient = redis;
  const subClient = createRedisDuplicate();
  io.adapter(createAdapter(pubClient, subClient));

  // Lets the worker container reach clients (link previews landing, a transcode finishing) even
  // though it has no Socket.IO server of its own. See realtime/emitBridge.ts.
  subscribeEmitBridge((room, event, payload) => {
    io?.to(room).emit(event, payload);
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    void joinInitialRooms(socket);
    // `sockets.size` is this process's own count, which is exactly what a per-instance gauge should
    // report — Prometheus sums across instances, and a global count read from the adapter would be
    // double-counted the moment there is more than one.
    setSocketConnections(io!.sockets.sockets.size);

    registerChannelRoomHandlers(io!, socket);
    registerMessageHandlers(io!, socket);
    registerTypingHandlers(io!, socket);
    registerPresenceHandlers(io!, socket);
    registerVoiceHandlers(io!, socket);

    socket.on("disconnect", () => {
      void handlePresenceDisconnect(io!, socket);
      void handleVoiceDisconnect(io!, socket);
      setSocketConnections(io!.sockets.sockets.size);
    });
  });

  // The boot reset above covers a process that stopped. This covers drift that accumulates while
  // one is running, by checking the stored column against the live socket table.
  startPresenceReconciler(io);

  return io;
}

async function joinInitialRooms(socket: import("socket.io").Socket): Promise<void> {
  const userId = socket.data.userId as string;
  await socket.join(`user:${userId}`);

  const { prisma } = await import("../db/prisma.js");
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { serverId: true },
  });
  for (const m of memberships) {
    await socket.join(`server:${m.serverId}`);
  }

  // NOTE: added for the web client — modules/messages/service.ts broadcasts DM message
  // create/update/delete and reaction events to room `dm:${conversationId}`, but nothing
  // previously joined any socket to that room (only `user:${userId}` and `server:${serverId}`
  // were auto-joined above), so DM realtime events were unreachable by any client. Mirrors
  // the server-membership auto-join immediately above: DM participation is DB-driven, not a
  // client-initiated join like channel:join, so it belongs here rather than as a new
  // ClientEvents entry.
  const participations = await prisma.dMParticipant.findMany({
    where: { userId },
    select: { conversationId: true },
  });
  for (const p of participations) {
    await socket.join(`dm:${p.conversationId}`);
  }
}
