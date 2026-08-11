import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { addReaction, deleteMessage, editMessage, removeReaction, togglePinMessage } from "./service.js";

const editSchema = z.object({ content: z.string().min(1) });
const reactionSchema = z.object({ emoji: z.string().min(1).max(32) });
const pinSchema = z.object({ pinned: z.boolean() });

/**
 * Mounted under /api/messages. No requireMembership/requirePermission
 * preHandlers here on purpose: these endpoints serve BOTH channel messages
 * (server-scoped) and DM messages (no serverId at all), so authorization for
 * both shapes is fully owned by modules/messages/service.ts — the same
 * functions the Socket.IO handlers call — rather than being split across a
 * preHandler chain that only fits one of the two cases.
 */
export default async function messageRoutes(fastify: FastifyInstance) {
  fastify.patch("/:id", { schema: { body: editSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof editSchema>;
    return editMessage({ userId: request.userId!, messageId: id, content: body.content });
  });

  fastify.delete("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteMessage({ userId: request.userId!, messageId: id });
    reply.code(204).send();
  });

  fastify.post("/:id/reactions", { schema: { body: reactionSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof reactionSchema>;
    const result = await addReaction({ userId: request.userId!, messageId: id, emoji: body.emoji });
    reply.code(201);
    return result;
  });

  fastify.delete("/:id/reactions", { schema: { body: reactionSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof reactionSchema>;
    return removeReaction({ userId: request.userId!, messageId: id, emoji: body.emoji });
  });

  fastify.patch("/:id/pin", { schema: { body: pinSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof pinSchema>;
    return togglePinMessage({ userId: request.userId!, messageId: id, pinned: body.pinned });
  });
}
