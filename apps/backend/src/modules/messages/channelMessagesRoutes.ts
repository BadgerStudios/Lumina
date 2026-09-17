import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { bulkDeleteMessages, createChannelMessage, listChannelMessages, listPinnedMessages, MAX_BULK_DELETE } from "./service.js";
import { parseMessageMultipart } from "./multipart.js";
import { uploadLimitsFor } from "../billing/premium.js";
import { createPoll } from "../polls/service.js";
import { prisma } from "../../db/prisma.js";
import { gifAttachment, recordGifShare, discardGifAttachment } from "../gifs/routes.js";

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

  const bulkDeleteSchema = z.object({ messages: z.array(z.string().min(1).max(32)).min(1).max(MAX_BULK_DELETE) });
  fastify.post(
    "/:id/messages/bulk-delete",
    {
      schema: { body: bulkDeleteSchema },
      config: { rateLimit: { max: 10, timeWindow: "10 seconds" } },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof bulkDeleteSchema>;
      return bulkDeleteMessages({ userId: request.userId!, channelId: id, messageIds: body.messages });
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
    {
      // Sending had no budget of its own — only the global per-IP allowance shared with every
      // other call. Generous enough that no ordinary conversation notices it.
      config: { rateLimit: { max: 30, timeWindow: "10 seconds" } },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromChannelParam("id"))],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { content, replyToId, attachments, stickerId, poll, gifSlug, gifQuery } = await parseMessageMultipart(
        request,
        // The sender's own ceiling: Premium buys a bigger one, and the plugin-level limit is
        // set to the premium value precisely so this check is the one that decides.
        uploadLimitsFor(
          (await prisma.user.findUnique({ where: { id: request.userId! }, select: { premiumUntil: true } }))
            ?.premiumUntil ?? null,
        ).attachmentBytes,
      );

      // The poll is created before the message, so a rejected poll (too few options, duplicate
      // labels) fails the send outright instead of posting an empty message next to a poll that
      // never existed. It is the only thing here that can be orphaned, and this is the ordering
      // that makes an orphan impossible: if createChannelMessage throws, the Poll row is unreferenced
      // and invisible rather than the message being visible and pollless.
      const pollId = poll ? await createPoll(poll) : null;

      // A GIF from the picker becomes an ordinary stored attachment, so it passes every check below.
      const gif = gifSlug ? await gifAttachment(gifSlug, request.userId!) : null;
      let dto;
      try {
        dto = await createChannelMessage({
          userId: request.userId!,
          channelId: id,
          content,
          replyToId,
          attachments: gif ? [...attachments, gif] : attachments,
          stickerId,
          pollId,
        });
      } catch (error) {
        if (gif) await discardGifAttachment(gif);
        throw error;
      }
      if (gif && gifSlug) recordGifShare(gifSlug, request.userId!, gifQuery);

      reply.code(201);
      return dto;
    },
  );
}
