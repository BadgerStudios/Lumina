import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { prisma } from "../../db/prisma.js";
import { NotFoundError } from "../../lib/errors.js";
import {
  createApplication,
  deleteApplication,
  listMyApplications,
  regenerateBotToken,
  regenerateClientSecret,
  updateRedirectUris,
} from "./service.js";

const createSchema = z.object({
  name: z.string().min(2).max(32),
  description: z.string().max(256).nullable().optional(),
});

const redirectUrisSchema = z.object({
  redirectUris: z.array(z.string().url()).max(10),
});

/** Mounted under /api/applications — the dev-portal "manage my bots" surface. */
export default async function applicationRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    return listMyApplications(request.userId!);
  });

  fastify.post("/", { schema: { body: createSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof createSchema>;
    const result = await createApplication({ ownerId: request.userId!, name: body.name, description: body.description });
    reply.code(201);
    return result;
  });

  fastify.post("/:id/regenerate-token", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return regenerateBotToken({ ownerId: request.userId!, applicationId: id });
  });

  fastify.patch("/:id/oauth/redirect-uris", { schema: { body: redirectUrisSchema }, preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof redirectUrisSchema>;
    return updateRedirectUris({ ownerId: request.userId!, applicationId: id, redirectUris: body.redirectUris });
  });

  /**
   * Privileged gateway intents, Discord-dev-portal style. Only the application's owner can flip
   * them, and OFF is the default — a bot reads message content or lists members only because a
   * human deliberately said so, twice (the toggle here AND the intent bit in IDENTIFY).
   */
  fastify.patch(
    "/:id/intents",
    {
      schema: { body: z.object({ messageContent: z.boolean().optional(), serverMembers: z.boolean().optional() }) },
      preHandler: [requireAuth],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { messageContent?: boolean; serverMembers?: boolean };
      const app = await prisma.application.findUnique({ where: { id }, select: { ownerId: true } });
      if (!app || app.ownerId !== request.userId) throw new NotFoundError("Application not found");
      const updated = await prisma.application.update({
        where: { id },
        data: {
          ...(body.messageContent !== undefined ? { intentMessageContent: body.messageContent } : {}),
          ...(body.serverMembers !== undefined ? { intentServerMembers: body.serverMembers } : {}),
        },
        select: { intentMessageContent: true, intentServerMembers: true },
      });
      return { messageContent: updated.intentMessageContent, serverMembers: updated.intentServerMembers };
    },
  );

  fastify.post("/:id/oauth/regenerate-secret", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return regenerateClientSecret({ ownerId: request.userId!, applicationId: id });
  });

  fastify.delete("/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteApplication({ ownerId: request.userId!, applicationId: id });
    reply.code(204).send();
  });
}
