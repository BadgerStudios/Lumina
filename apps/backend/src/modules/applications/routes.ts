import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
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
