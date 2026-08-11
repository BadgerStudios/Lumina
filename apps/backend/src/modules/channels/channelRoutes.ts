import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeChannel } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

const updateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  topic: z.string().max(1024).nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().optional(),
  slowmodeSeconds: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
});

/** Mounted under /api/channels */
export default async function channelRoutes(fastify: FastifyInstance) {
  fastify.patch(
    "/:id",
    {
      schema: { body: updateChannelSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromChannelParam("id")),
        requirePermission(Permissions.MANAGE_CHANNELS),
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof updateChannelSchema>;

      const channel = await prisma.channel.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.topic !== undefined ? { topic: body.topic } : {}),
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.slowmodeSeconds !== undefined ? { slowmodeSeconds: body.slowmodeSeconds } : {}),
          ...(body.nsfw !== undefined ? { nsfw: body.nsfw } : {}),
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.update",
        targetId: channel.id,
        targetType: "channel",
        metadata: body,
      });

      const dto = serializeChannel(channel);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_UPDATE, dto);
      return dto;
    },
  );

  fastify.delete(
    "/:id",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromChannelParam("id")),
        requirePermission(Permissions.MANAGE_CHANNELS),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const channel = await prisma.channel.findUnique({ where: { id } });
      if (!channel) throw new NotFoundError("Channel not found");

      await prisma.channel.delete({ where: { id } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.delete",
        targetId: id,
        targetType: "channel",
      });

      getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_DELETE, { id, serverId: request.serverId });
      reply.code(204).send();
    },
  );
}
