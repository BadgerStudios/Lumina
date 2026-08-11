import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { createDMMessage, listDMMessages } from "./service.js";
import { parseMessageMultipart } from "./multipart.js";

const listQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.string().optional(),
});

/** Mounted under /api/dm */
export default async function dmMessagesRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:conversationId/messages",
    { schema: { querystring: listQuerySchema }, preHandler: [requireAuth] },
    async (request) => {
      const { conversationId } = request.params as { conversationId: string };
      const query = request.query as z.infer<typeof listQuerySchema>;
      return listDMMessages({ userId: request.userId!, conversationId, before: query.before, limit: query.limit });
    },
  );

  fastify.post("/:conversationId/messages", { preHandler: [requireAuth] }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { content, replyToId, attachments } = await parseMessageMultipart(request);
    const dto = await createDMMessage({
      userId: request.userId!,
      conversationId,
      content,
      replyToId,
      attachments,
    });
    reply.code(201);
    return dto;
  });
}
