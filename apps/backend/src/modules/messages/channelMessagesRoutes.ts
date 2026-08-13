import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { createChannelMessage, listChannelMessages, listPinnedMessages } from "./service.js";
import { parseMessageMultipart } from "./multipart.js";
import { createPoll } from "../polls/service.js";

const listQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.string().optional(),
});

/** Mounted under /api/channels */
export default async function channelMessagesRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/messages",
    { schema: { querystring: listQuerySchema }, preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as z.infer<typeof listQuerySchema>;
      return listChannelMessages({ userId: request.userId!, channelId: id, before: query.before, limit: query.limit });
    },
  );

  fastify.get(
    "/:id/pins",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request) => {
      const { id } = request.params as { id: string };
      return listPinnedMessages({ userId: request.userId!, channelId: id });
    },
  );

  // requireMembership only (early 404/403 before we touch the multipart
  // stream) — final authorization (SEND_MESSAGES / ATTACH_FILES / mute
  // check) lives in service.ts, the single source of truth shared with the
  // Socket.IO message:send handler.
  fastify.post(
    "/:id/messages",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { content, replyToId, attachments, stickerId, poll } = await parseMessageMultipart(request);

      // The poll is created before the message, so a rejected poll (too few options, duplicate
      // labels) fails the send outright instead of posting an empty message next to a poll that
      // never existed. It is the only thing here that can be orphaned, and this is the ordering
      // that makes an orphan impossible: if createChannelMessage throws, the Poll row is unreferenced
      // and invisible rather than the message being visible and pollless.
      const pollId = poll ? await createPoll(poll) : null;

      const dto = await createChannelMessage({
        userId: request.userId!,
        channelId: id,
        content,
        replyToId,
        attachments,
        stickerId,
        pollId,
      });

      reply.code(201);
      return dto;
    },
  );
}
