import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import {
  requireAuth,
  requireMembership,
  requirePermission,
  resolveServerId,
} from "../../plugins/authenticate.js";
import { completeOnboarding, getMemberState, getOnboarding, saveOnboarding } from "./service.js";

const optionSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(200).nullish(),
  emoji: z.string().max(16).nullish(),
  roleIds: z.array(z.string()).max(10).default([]),
});

const saveSchema = z.object({
  enabled: z.boolean(),
  welcomeTitle: z.string().max(120).nullish(),
  welcomeBody: z.string().max(1000).nullish(),
  rules: z.string().max(4000).nullish(),
  requireRules: z.boolean().default(false),
  prompts: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        multiple: z.boolean().default(false),
        options: z.array(optionSchema).min(1).max(20),
      }),
    )
    .max(10)
    .default([]),
});

const completeSchema = z.object({
  optionIds: z.array(z.string()).max(60).default([]),
  acceptedRules: z.boolean().default(false),
});

/**
 * Server onboarding, mounted under /api/servers/:serverId/onboarding.
 *
 * Reading and completing are open to any member — between them they ARE the welcome screen.
 * Editing needs MANAGE_SERVER, the same permission that already governs the rest of a server's
 * identity, and is gated by the same preHandler pair the other server routes use rather than a
 * hand-rolled check.
 */
export default async function onboardingRoutes(fastify: FastifyInstance) {
  const member = [requireAuth, requireMembership(resolveServerId.fromParam("serverId"))];
  const manager = [...member, requirePermission(Permissions.MANAGE_SERVER)];

  fastify.get("/", { preHandler: member }, async (request) => {
    const { serverId } = request.params as { serverId: string };
    return getMemberState(serverId, request.userId!);
  });

  fastify.post(
    "/complete",
    { schema: { body: completeSchema }, preHandler: member },
    async (request) => {
      const { serverId } = request.params as { serverId: string };
      const body = request.body as z.infer<typeof completeSchema>;
      return completeOnboarding({
        serverId,
        userId: request.userId!,
        optionIds: body.optionIds,
        acceptedRules: body.acceptedRules,
      });
    },
  );

  /** The raw configuration, for the editor. */
  fastify.get("/config", { preHandler: manager }, async (request) => {
    const { serverId } = request.params as { serverId: string };
    return getOnboarding(serverId);
  });

  fastify.patch("/config", { schema: { body: saveSchema }, preHandler: manager }, async (request) => {
    const { serverId } = request.params as { serverId: string };
    return saveOnboarding(serverId, request.body as z.infer<typeof saveSchema>);
  });
}
