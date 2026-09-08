import type { Server as SocketIOServer, Socket } from "socket.io";
import { ClientEvents } from "@lumina/shared";
import {
  addReaction,
  createChannelMessage,
  createDMMessage,
  deleteMessage,
  editMessage,
  removeReaction,
} from "../../modules/messages/service.js";

/**
 * These handlers call the EXACT SAME service functions used by the REST
 * routes in modules/messages/routes.ts — permission checks, persistence,
 * and room broadcast all live in modules/messages/service.ts. This handler
 * is only responsible for wiring socket events to those functions and
 * acking/erroring back to the sending client.
 */
export function registerMessageHandlers(_io: SocketIOServer, socket: Socket): void {
  const userId = socket.data.userId as string;
  // Flood control for the one write path that bypasses the HTTP rate limiter: socket events never
  // pass through Fastify's pipeline, slowmode is off by default and absent for DMs. Same shape as
  // the soundboard limiter — five sends per five seconds, then a clear error (2026-09-08 audit).
  const sendHistory: number[] = [];

  socket.on(
    ClientEvents.MESSAGE_SEND,
    async (
      payload: { channelId?: string; conversationId?: string; content: string; replyToId?: string | null },
      ack?: (res: { ok: true; data: unknown } | { ok: false; error: string }) => void,
    ) => {
      try {
        const now = Date.now();
        while (sendHistory.length > 0 && now - sendHistory[0] > 5_000) sendHistory.shift();
        if (sendHistory.length >= 5) {
          ack?.({ ok: false, error: "You're sending messages too quickly" });
          return;
        }
        sendHistory.push(now);
        let dto;
        if (payload.channelId) {
          dto = await createChannelMessage({
            userId,
            channelId: payload.channelId,
            content: payload.content,
            replyToId: payload.replyToId ?? null,
          });
        } else if (payload.conversationId) {
          dto = await createDMMessage({
            userId,
            conversationId: payload.conversationId,
            content: payload.content,
            replyToId: payload.replyToId ?? null,
          });
        } else {
          throw new Error("channelId or conversationId is required");
        }
        ack?.({ ok: true, data: dto });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(
    ClientEvents.MESSAGE_EDIT,
    async (
      payload: { messageId: string; content: string },
      ack?: (res: { ok: true; data: unknown } | { ok: false; error: string }) => void,
    ) => {
      try {
        const dto = await editMessage({ userId, messageId: payload.messageId, content: payload.content });
        ack?.({ ok: true, data: dto });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(
    ClientEvents.MESSAGE_DELETE,
    async (
      payload: { messageId: string },
      ack?: (res: { ok: true; data: unknown } | { ok: false; error: string }) => void,
    ) => {
      try {
        const result = await deleteMessage({ userId, messageId: payload.messageId });
        ack?.({ ok: true, data: result });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(
    ClientEvents.REACTION_ADD,
    async (
      payload: { messageId: string; emoji: string },
      ack?: (res: { ok: true; data: unknown } | { ok: false; error: string }) => void,
    ) => {
      try {
        const result = await addReaction({ userId, messageId: payload.messageId, emoji: payload.emoji });
        ack?.({ ok: true, data: result });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );

  socket.on(
    ClientEvents.REACTION_REMOVE,
    async (
      payload: { messageId: string; emoji: string },
      ack?: (res: { ok: true; data: unknown } | { ok: false; error: string }) => void,
    ) => {
      try {
        const result = await removeReaction({ userId, messageId: payload.messageId, emoji: payload.emoji });
        ack?.({ ok: true, data: result });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  );
}
