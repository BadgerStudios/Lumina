import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { createDMMessage, listDMMessages } from "./service.js";
import { parseMessageMultipart } from "./multipart.js";
import { uploadLimitsFor } from "../billing/premium.js";
import { createPoll } from "../polls/service.js";
import { prisma } from "../../db/prisma.js";

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

  // A DM has no slowmode to fall back on, so this is the only brake on bursting messages at
  // someone. Same ceiling as the channel route.
  fastify.post(
    "/:conversationId/messages",
    { config: { rateLimit: { max: 30, timeWindow: "10 seconds" } }, preHandler: [requireAuth] },
    async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const { content, replyToId, attachments, stickerId, poll } = await parseMessageMultipart(
        request,
        // The sender's own ceiling: Premium buys a bigger one, and the plugin-level limit is
        // set to the premium value precisely so this check is the one that decides.
        uploadLimitsFor(
          (await prisma.user.findUnique({ where: { id: request.userId! }, select: { premiumUntil: true } }))
            ?.premiumUntil ?? null,
        ).attachmentBytes,
      );
    // Same ordering as the channel route, for the same reason: a rejected poll fails the send
    // rather than leaving a message with no poll next to a poll with no message.
    const pollId = poll ? await createPoll(poll) : null;
    const dto = await createDMMessage({
      userId: request.userId!,
      conversationId,
      content,
      replyToId,
      attachments,
      stickerId,
      pollId,
    });
    reply.code(201);
    return dto;
  });
}
