import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { votePoll } from "./service.js";

const voteSchema = z.object({ optionId: z.string().min(1) });

/**
 * Mounted under /api/polls.
 *
 * Only voting lives here — creating a poll is part of sending a message (see
 * modules/messages/routes.ts), because a poll with no message is unreachable.
 */
export default async function pollRoutes(fastify: FastifyInstance) {
  fastify.post("/:pollId/vote", { schema: { body: voteSchema }, preHandler: [requireAuth] }, async (request) => {
    const { pollId } = request.params as { pollId: string };
    const { optionId } = request.body as z.infer<typeof voteSchema>;
    return votePoll({ userId: request.userId!, pollId, optionId });
  });
}
