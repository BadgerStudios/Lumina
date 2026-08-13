import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerEvents } from "@lumina/shared";
import { requireAuth } from "../../plugins/authenticate.js";
import { getIO } from "../../realtime/io.js";
import {
  AUTO_ARCHIVE_CHOICES,
  createThread,
  getThread,
  listThreads,
  setThreadArchived,
  setThreadMembership,
} from "./service.js";

const createThreadSchema = z.object({
  name: z.string().min(1).max(100),
  autoArchiveMinutes: z.number().int().refine((v) => AUTO_ARCHIVE_CHOICES.includes(v)).optional(),
  originMessageId: z.string().regex(/^\d+$/).optional(),
});

const archiveSchema = z.object({ archived: z.boolean() });

/**
 * Mounted under /api.
 *
 * Deliberately NOT using requireMembership/requirePermission preHandlers: every route here needs
 * the *parent* channel's permissions, and the resolver-based preHandlers resolve against the id in
 * the path — which for these routes is the thread, whose own overwrite set is empty by design.
 * The service layer resolves through the parent instead (see permissionSourceChannelId), so the
 * checks live there and each handler stays a thin wrapper.
 */
export default async function threadRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/channels/:id/threads",
    { schema: { body: createThreadSchema }, preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof createThreadSchema>;
      const thread = await createThread({ userId: request.userId!, channelId: id, ...body });

      // To the whole server room, not the parent channel room: a thread is a new channel, and
      // clients keep their channel list per server. Members who cannot see the parent are filtered
      // out client-side by never having the parent in their list — and server-side by every
      // subsequent fetch of the thread itself.
      getIO().to(`server:${thread.serverId}`).emit(ServerEvents.THREAD_CREATE, thread);
      reply.code(201);
      return thread;
    },
  );

  fastify.get("/channels/:id/threads", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const { archived } = request.query as { archived?: string };
    return listThreads({ userId: request.userId!, channelId: id, archived: archived === "true" });
  });

  fastify.get("/threads/:id", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return getThread(id, request.userId!);
  });

  fastify.put("/threads/:id/members/@me", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await setThreadMembership(id, request.userId!, true);
    reply.code(204).send();
  });

  fastify.delete("/threads/:id/members/@me", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await setThreadMembership(id, request.userId!, false);
    reply.code(204).send();
  });

  fastify.patch(
    "/threads/:id/archive",
    { schema: { body: archiveSchema }, preHandler: [requireAuth] },
    async (request) => {
      const { id } = request.params as { id: string };
      const { archived } = request.body as z.infer<typeof archiveSchema>;
      const thread = await setThreadArchived(id, request.userId!, archived);
      getIO().to(`server:${thread.serverId}`).emit(ServerEvents.THREAD_UPDATE, thread);
      return thread;
    },
  );
}
