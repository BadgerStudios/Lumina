import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { createWebhook, listChannelWebhooks } from "./service.js";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.string().url().nullable().optional(),
});

/** Mounted under /api/channels */
export default async function channelWebhookRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/webhooks",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request) => {
      const { id } = request.params as { id: string };
      return listChannelWebhooks({ userId: request.userId!, channelId: id });
    },
  );

  fastify.post(
    "/:id/webhooks",
    { schema: { body: createSchema }, preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof createSchema>;
      const result = await createWebhook({ userId: request.userId!, channelId: id, name: body.name, avatarUrl: body.avatarUrl });
      reply.code(201);
      return result;
    },
  );
}
