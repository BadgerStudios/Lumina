import type { FastifyInstance } from "fastify";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { markChannelRead } from "./service.js";

/** Mounted under /api/channels */
export default async function channelReadRoutes(fastify: FastifyInstance) {
  fastify.patch(
    "/:id/read",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await markChannelRead({ userId: request.userId!, channelId: id });
      reply.code(204).send();
    },
  );
}
