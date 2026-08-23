import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents } from "@lumina/shared";

/** Ephemeral typing indicators — no persistence, just room broadcast. */
export function registerTypingHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  // Only relay for a channel this socket has actually joined. A socket joins a channel room only
  // via CHANNEL_JOIN, which runs the membership + VIEW_CHANNELS check (see channelRoom.ts) — so
  // gating on room membership here reuses that check. Without it, any authenticated user could
  // inject a spoofed "X is typing" into any channel id they could guess.
  const inChannel = (channelId: string) => socket.rooms.has(`channel:${channelId}`);

  socket.on(ClientEvents.TYPING_START, (payload: { channelId: string }) => {
    if (!payload?.channelId || !inChannel(payload.channelId)) return;
    io.to(`channel:${payload.channelId}`).emit(ServerEvents.TYPING_UPDATE, {
      channelId: payload.channelId,
      userId,
      isTyping: true,
    });
  });

  socket.on(ClientEvents.TYPING_STOP, (payload: { channelId: string }) => {
    if (!payload?.channelId || !inChannel(payload.channelId)) return;
    io.to(`channel:${payload.channelId}`).emit(ServerEvents.TYPING_UPDATE, {
      channelId: payload.channelId,
      userId,
      isTyping: false,
    });
  });
}
