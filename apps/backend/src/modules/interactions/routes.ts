import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import {
  invokeCommand,
  invokeComponent,
  listCommandsForApplication,
  listCommandsForServer,
  listPendingInteractions,
  overwriteCommands,
  respondToInteraction,
} from "./service.js";

const invokeSchema = z.object({
  channelId: z.string().optional(),
  dmConversationId: z.string().optional(),
  name: z.string().min(1).max(32),
  options: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

const componentSchema = z.object({
  messageId: z.string().min(1),
  customId: z.string().min(1).max(100),
  values: z.array(z.string().max(100)).max(25).optional(),
});

const respondSchema = z.object({
  content: z.string().max(4000).optional(),
  components: z.unknown().optional(),
  ephemeral: z.boolean().optional(),
});

/**
 * Resolves the caller's own application from a bot token.
 *
 * requireAuth already turned `Bot <token>` into the bot's userId; this walks back to the
 * Application. A human token has no application behind it and is refused — command registration is
 * something an application does for itself, not something a user does on its behalf, which is what
 * keeps one developer from registering commands under someone else's application id.
 */
async function callerApplication(userId: string): Promise<{ id: string }> {
  const application = await prisma.application.findFirst({
    where: { botUser: { id: userId } },
    select: { id: true },
  });
  if (!application) throw new ForbiddenError("This endpoint requires a bot token");
  return application;
}

/** Mounted under /api/interactions. */
export default async function interactionRoutes(fastify: FastifyInstance) {
  /** Bulk overwrite of this bot's whole command set — see the note in service.ts on why. */
  fastify.put("/commands", { preHandler: [requireAuth] }, async (request) => {
    const application = await callerApplication(request.userId!);
    return overwriteCommands(application.id, request.body);
  });

  fastify.get("/commands", { preHandler: [requireAuth] }, async (request) => {
    const application = await callerApplication(request.userId!);
    return listCommandsForApplication(application.id);
  });

  /** For a bot that would rather poll than hold a socket. */
  fastify.get("/pending", { preHandler: [requireAuth] }, async (request) => {
    const application = await callerApplication(request.userId!);
    return listPendingInteractions(application.id);
  });

  /**
   * The bot's answer. Deliberately NOT behind requireAuth: the interaction token is the
   * authorization, and it is single-use, unguessable and scoped to exactly one interaction. See
   * the note at the top of service.ts.
   */
  fastify.post("/:token/respond", { schema: { body: respondSchema } }, async (request) => {
    const { token } = request.params as { token: string };
    const body = request.body as z.infer<typeof respondSchema>;
    return respondToInteraction({ token, ...body });
  });

  /** What a human client draws its `/` palette from. */
  fastify.get(
    "/commands/server/:id",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => listCommandsForServer(request.serverId!),
  );

  fastify.post("/invoke", { schema: { body: invokeSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof invokeSchema>;
    if (!body.channelId && !body.dmConversationId) throw new NotFoundError("A command needs a channel or a DM");
    return invokeCommand({
      userId: request.userId!,
      channelId: body.channelId ?? null,
      dmConversationId: body.dmConversationId ?? null,
      commandName: body.name,
      options: body.options,
    });
  });

  fastify.post("/component", { schema: { body: componentSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof componentSchema>;
    return invokeComponent({
      userId: request.userId!,
      messageId: body.messageId,
      customId: body.customId,
      values: body.values,
    });
  });
}
