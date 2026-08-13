import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { serializeServer } from "../../lib/serialize.js";
import { NotFoundError } from "../../lib/errors.js";
import { applyTemplate, createTemplate, deleteTemplate, getTemplate, listMyTemplates } from "./service.js";

const createSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(300).nullable().optional(),
});

const applySchema = z.object({
  name: z.string().min(1).max(100),
});

/** Mounted under /api/templates. */
export default async function templateRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => listMyTemplates(request.userId!));

  fastify.post("/", { schema: { body: createSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof createSchema>;
    const template = await createTemplate({
      userId: request.userId!,
      serverId: body.serverId,
      name: body.name,
      description: body.description,
    });
    reply.code(201);
    return template;
  });

  /**
   * Readable by any signed-in user who holds the code — that is what makes a template shareable.
   * The response is a summary (counts, name, description), never the snapshot itself: there is no
   * reason for the channel names of someone else's server to travel with the preview.
   */
  fastify.get("/:code", { preHandler: [requireAuth] }, async (request) => {
    const { code } = request.params as { code: string };
    return getTemplate(code);
  });

  fastify.post("/:code/apply", { schema: { body: applySchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as z.infer<typeof applySchema>;
    const { id } = await applyTemplate({ userId: request.userId!, code, name: body.name });

    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundError("Server not found");
    reply.code(201);
    return serializeServer(server);
  });

  fastify.delete("/:code", { preHandler: [requireAuth] }, async (request, reply) => {
    const { code } = request.params as { code: string };
    await deleteTemplate({ userId: request.userId!, code });
    reply.code(204);
  });
}
