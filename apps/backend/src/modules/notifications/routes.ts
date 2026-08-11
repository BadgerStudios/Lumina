import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { getNotificationOverrides, setNotificationOverride, SERVER_LEVEL_CHANNEL } from "./service.js";

const levelSchema = z.enum(["ALL", "MENTIONS", "NONE"]);

const setOverrideSchema = z.object({
  channelId: z.string().nullable(),
  level: levelSchema,
});

/** Mounted under /api/servers — a user's OWN notification preferences for a server they're a
 * member of, not a moderation/permission-gated setting (no requirePermission beyond membership;
 * this only ever touches the caller's own NotificationOverride rows). */
export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/notification-settings",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const rows = await getNotificationOverrides(request.userId!, request.serverId!);
      return rows.map((r) => ({
        channelId: r.channelId === SERVER_LEVEL_CHANNEL ? null : r.channelId,
        level: r.level,
      }));
    },
  );

  fastify.put(
    "/:id/notification-settings",
    {
      schema: { body: setOverrideSchema },
      preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof setOverrideSchema>;
      await setNotificationOverride({
        userId: request.userId!,
        serverId: request.serverId!,
        channelId: body.channelId,
        level: body.level,
      });
      reply.code(204).send();
    },
  );
}
