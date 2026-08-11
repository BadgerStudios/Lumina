import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import {
  blockUser,
  listBlockedUsers,
  listMyFriendRequests,
  listMyFriends,
  removeFriend,
  resolveFriendRequest,
  sendFriendRequest,
  unblockUser,
} from "./service.js";
import { dismissSuggestion, getFriendSuggestions } from "./suggestions.js";

const sendSchema = z.object({ username: z.string().min(1) });
const blockSchema = z.object({ username: z.string().min(1) });

/** Mounted under /api/friends */
export default async function friendRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    return listMyFriends(request.userId!);
  });

  fastify.delete("/:userId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    await removeFriend({ userId: request.userId!, otherUserId: userId });
    reply.code(204).send();
  });

  fastify.get("/requests", { preHandler: [requireAuth] }, async (request) => {
    return listMyFriendRequests(request.userId!);
  });

  fastify.post("/requests", { schema: { body: sendSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof sendSchema>;
    const result = await sendFriendRequest({ requesterId: request.userId!, addresseeUsername: body.username });
    reply.code(201);
    return result;
  });

  fastify.post("/requests/:id/accept", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    await resolveFriendRequest({ userId: request.userId!, requestId: id, accept: true });
    return { ok: true };
  });

  fastify.post("/requests/:id/decline", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    await resolveFriendRequest({ userId: request.userId!, requestId: id, accept: false });
    return { ok: true };
  });

  /** People you may know. Rate limited and no-store: the body is a set of social-graph
   * inferences, not something to sit in an intermediary cache. */
  fastify.get(
    "/suggestions",
    { preHandler: [requireAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(25, Math.max(1, Number(query.limit ?? 10) || 10));
      reply.header("cache-control", "no-store");
      return getFriendSuggestions(request.userId!, limit);
    },
  );

  fastify.delete(
    "/suggestions/:userId",
    { preHandler: [requireAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      await dismissSuggestion(request.userId!, userId);
      reply.code(204).send();
    },
  );

  fastify.get("/blocked", { preHandler: [requireAuth] }, async (request) => {
    return listBlockedUsers(request.userId!);
  });

  fastify.post("/block", { schema: { body: blockSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof blockSchema>;
    await blockUser({ blockerId: request.userId!, blockedUsername: body.username });
    reply.code(204).send();
  });

  fastify.post("/:userId/unblock", { preHandler: [requireAuth] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    await unblockUser({ blockerId: request.userId!, blockedUserId: userId });
    reply.code(204).send();
  });
}
