import type { FastifyInstance } from "fastify";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { markChannelRead, markChannelUnread } from "./service.js";

/** Mounted under /api/channels */
export default async function channelReadRoutes(fastify: FastifyInstance) {
  fastify.patch(
    "/:id/read",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request) => {
      const { id } = request.params as { id: string };
      // Returns { previousLastReadMessageId } — the client anchors the "new messages" divider at
      // the position this call just cleared (see frontend queries/readState.ts).
      return markChannelRead({ userId: request.userId!, channelId: id });
    },
  );

  fastify.patch(
    "/:id/unread",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { messageId } = request.body as { messageId?: string };
      if (!messageId) { reply.code(400).send({ error: "messageId required" }); return; }
      await markChannelUnread({ userId: request.userId!, channelId: id, messageId });
      reply.code(204).send();
    },
  );
}
