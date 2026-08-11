import type { FastifyInstance } from "fastify";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { listServerWebhooks } from "./service.js";

/** Mounted under /api/servers — backs the Webhooks tab in ServerSettingsModal.tsx, which lists
 * every webhook across every channel in one place. */
export default async function serverWebhookRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/webhooks",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const { id } = request.params as { id: string };
      return listServerWebhooks({ userId: request.userId!, serverId: id });
    },
  );
}
