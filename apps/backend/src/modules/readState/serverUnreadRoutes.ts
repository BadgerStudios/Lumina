import type { FastifyInstance } from "fastify";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { getServerUnread } from "./service.js";

/** Mounted under /api/servers */
export default async function serverUnreadRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/unread",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      return getServerUnread({ userId: request.userId!, serverId: request.serverId! });
    },
  );
}
