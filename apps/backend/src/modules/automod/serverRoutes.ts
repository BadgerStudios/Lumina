import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import {
  requireAuth,
  requireMembership,
  requirePermission,
  resolveServerId,
} from "../../plugins/authenticate.js";
import { createRule, deleteRule, listRules, updateRule } from "./service.js";

/**
 * AutoMod rule management, mounted under /api/servers.
 *
 * Every route requires MANAGE_SERVER, the same permission that gates roles and server settings —
 * an AutoMod rule can silently prevent a member from speaking, which is moderation authority, not
 * a preference.
 */

const termsSchema = z
  .array(z.string().min(1).max(120))
  .min(1, "A rule needs at least one term")
  .max(200);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  terms: termsSchema,
  wholeWord: z.boolean().optional(),
  exemptRoleIds: z.array(z.string()).max(50).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  terms: termsSchema.optional(),
  wholeWord: z.boolean().optional(),
  enabled: z.boolean().optional(),
  exemptRoleIds: z.array(z.string()).max(50).optional(),
});

export default async function autoModServerRoutes(fastify: FastifyInstance) {
  const guard = (param: string) => [
    requireAuth,
    requireMembership(resolveServerId.fromParam(param)),
    requirePermission(Permissions.MANAGE_SERVER),
  ];

  fastify.get("/:id/automod", { preHandler: guard("id") }, async (request) =>
    listRules(request.serverId!),
  );

  fastify.post(
    "/:id/automod",
    { schema: { body: createSchema }, preHandler: guard("id") },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createSchema>;
      const id = await createRule({
        serverId: request.serverId!,
        name: body.name,
        terms: body.terms,
        wholeWord: body.wholeWord,
        exemptRoleIds: body.exemptRoleIds,
        createdById: request.userId!,
      });
      reply.code(201);
      return { id };
    },
  );

  fastify.patch(
    "/:id/automod/:ruleId",
    { schema: { body: updateSchema }, preHandler: guard("id") },
    async (request, reply) => {
      const { ruleId } = request.params as { ruleId: string };
      await updateRule({
        serverId: request.serverId!,
        ruleId,
        ...(request.body as z.infer<typeof updateSchema>),
      });
      reply.code(204);
    },
  );

  fastify.delete("/:id/automod/:ruleId", { preHandler: guard("id") }, async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    await deleteRule(request.serverId!, ruleId);
    reply.code(204);
  });
}
