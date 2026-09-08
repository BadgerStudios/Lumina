import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { submitContentReport } from "./service.js";

const REASONS = [
  "SPAM",
  "HARASSMENT",
  "VIOLENCE",
  "SEXUAL_CONTENT",
  "HATE_SPEECH",
  "SELF_HARM",
  "ILLEGAL",
  "OTHER",
] as const;

const bodySchema = z.object({
  targetType: z.enum(["USER", "MESSAGE"]),
  targetId: z.string().min(1),
  reason: z.enum(REASONS),
  details: z.string().max(1000).optional(),
});

/** Mounted under /api/reports — reporting a user or a message (feed videos use /api/videos/:id/report). */
export default async function contentReportRoutes(fastify: FastifyInstance) {
  fastify.post("/", { schema: { body: bodySchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof bodySchema>;
    const result = await submitContentReport({ reporterId: request.userId!, ...body });
    reply.code(201);
    return result;
  });
}
