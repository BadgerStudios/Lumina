import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../plugins/authenticate.js";
import { listInbox, markAllRead, unreadCount } from "./service.js";

/** Mounted under /api/inbox — the unified Activity feed. */
export default async function inboxRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    const { before } = request.query as { before?: string };
    const rows = await listInbox(request.userId!, before);
    return rows.map((n) => ({
      id: n.id.toString(),
      kind: n.kind,
      actor: n.actor,
      actorCount: n.actorCount,
      messageId: n.messageId?.toString() ?? null,
      channelId: n.channelId,
      serverId: n.serverId,
      videoId: n.videoId,
      preview: n.preview,
      readAt: n.readAt?.toISOString() ?? null,
      updatedAt: n.updatedAt.toISOString(),
    }));
  });

  fastify.get("/unread-count", { preHandler: [requireAuth] }, async (request) => ({
    count: await unreadCount(request.userId!),
  }));

  fastify.post("/read", { preHandler: [requireAuth] }, async (request, reply) => {
    await markAllRead(request.userId!);
    reply.code(204).send();
  });
}
