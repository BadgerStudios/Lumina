import type { FastifyInstance } from "fastify";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { getServerUnread, markServerRead } from "./service.js";

/** Mounted under /api/servers */
export default async function serverUnreadRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/unread",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      return getServerUnread({ userId: request.userId!, serverId: request.serverId! });
    },
  );

  // Mark every text channel in the space read — the "mark space as read" action.
  fastify.post(
    "/:id/read",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      await markServerRead({ userId: request.userId!, serverId: request.serverId! });
      return { ok: true };
    },
  );
}
