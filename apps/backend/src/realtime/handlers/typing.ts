import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents } from "@lumina/shared";

/** Ephemeral typing indicators — no persistence, just room broadcast. */
export function registerTypingHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  socket.on(ClientEvents.TYPING_START, (payload: { channelId: string }) => {
    if (!payload?.channelId) return;
    io.to(`channel:${payload.channelId}`).emit(ServerEvents.TYPING_UPDATE, {
      channelId: payload.channelId,
      userId,
      isTyping: true,
    });
  });

  socket.on(ClientEvents.TYPING_STOP, (payload: { channelId: string }) => {
    if (!payload?.channelId) return;
    io.to(`channel:${payload.channelId}`).emit(ServerEvents.TYPING_UPDATE, {
      channelId: payload.channelId,
      userId,
      isTyping: false,
    });
  });
}
