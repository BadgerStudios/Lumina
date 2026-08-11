import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { deleteWebhook, postToWebhook } from "./service.js";

const postSchema = z.object({
  content: z.string().min(1),
  username: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().optional(),
});

/** Mounted under /api/webhooks */
export default async function webhookRoutes(fastify: FastifyInstance) {
  fastify.delete(
    "/:id",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromWebhookParam("id"))] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await deleteWebhook({ userId: request.userId!, webhookId: id });
      reply.code(204).send();
    },
  );

  // Deliberately NO requireAuth here — the :token in the URL is the entire authentication (see
  // service.ts postToWebhook), matching Discord's public incoming-webhook URL pattern exactly.
  fastify.post("/:id/:token", { schema: { body: postSchema } }, async (request, reply) => {
    const { id, token } = request.params as { id: string; token: string };
    const body = request.body as z.infer<typeof postSchema>;
    const message = await postToWebhook({ webhookId: id, token, content: body.content, username: body.username, avatarUrl: body.avatarUrl });
    reply.code(201);
    return message;
  });
}
