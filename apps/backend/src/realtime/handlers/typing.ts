import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents, ServerEvents } from "@lumina/shared";

/** Ephemeral typing indicators — no persistence, just room broadcast. */
export function registerTypingHandlers(io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;

  // Only relay into a room this socket has actually joined. A socket joins `channel:<id>` only
  // via CHANNEL_JOIN, which runs the membership + VIEW_CHANNELS check (see channelRoom.ts), and
  // `dm:<id>` only for conversations it participates in (see joinInitialRooms in realtime/io.ts)
  // — so gating on room membership here reuses both checks. Without it, any authenticated user
  // could inject a spoofed "X is typing" into any id they could guess.
  //
  // DMs relayed nothing before this, for no better reason than the handler knowing one room name.
  // The id alone decides which it is: whichever room the socket is in is the one it may broadcast
  // to, so nothing here is looser than it was — it just covers both kinds of conversation.
  const roomFor = (id: string): string | null => {
    if (socket.rooms.has(`channel:${id}`)) return `channel:${id}`;
    if (socket.rooms.has(`dm:${id}`)) return `dm:${id}`;
    return null;
  };

  const relay = (isTyping: boolean) => (payload: { channelId: string }) => {
    const room = payload?.channelId ? roomFor(payload.channelId) : null;
    if (!room) return;
    io.to(room).emit(ServerEvents.TYPING_UPDATE, { channelId: payload.channelId, userId, isTyping });
  };

  socket.on(ClientEvents.TYPING_START, relay(true));
  socket.on(ClientEvents.TYPING_STOP, relay(false));
}
