import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { redis, createRedisDuplicate } from "../db/redis.js";
import { env } from "../config/env.js";
import { authenticateSocket } from "./middleware/authenticateSocket.js";
import { registerMessageHandlers } from "./handlers/message.js";
import { registerTypingHandlers } from "./handlers/typing.js";
import { registerPresenceHandlers, handlePresenceDisconnect } from "./handlers/presence.js";
import { registerChannelRoomHandlers } from "./handlers/channelRoom.js";
import { registerVoiceHandlers, handleVoiceDisconnect } from "./handlers/voice.js";

let io: SocketIOServer | undefined;

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.IO server has not been initialized yet");
  return io;
}

export async function initIO(httpServer: HTTPServer): Promise<SocketIOServer> {
  const origins = env.CORS_ORIGIN.split(",").map((s) => s.trim());

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: origins,
      credentials: true,
    },
  });

  const pubClient = redis;
  const subClient = createRedisDuplicate();
  io.adapter(createAdapter(pubClient, subClient));

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    void joinInitialRooms(socket);

    registerChannelRoomHandlers(io!, socket);
    registerMessageHandlers(io!, socket);
    registerTypingHandlers(io!, socket);
    registerPresenceHandlers(io!, socket);
    registerVoiceHandlers(io!, socket);

    socket.on("disconnect", () => {
      void handlePresenceDisconnect(io!, socket);
      void handleVoiceDisconnect(io!, socket);
    });
  });

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
