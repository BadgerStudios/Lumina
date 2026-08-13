import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import type { VoiceParticipantDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeChannel, serializeUser } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { filterVisibleChannels } from "../../permissions/permissionService.js";
import { getIO } from "../../realtime/io.js";
import { ServerEvents } from "@lumina/shared";

const createChannelSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["TEXT", "CATEGORY", "VOICE"]).default("TEXT"),
  topic: z.string().max(1024).nullable().optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

const reorderSchema = z.object({
  order: z.array(z.object({ id: z.string(), position: z.number().int() })).min(1),
});

/** Mounted under /api/servers */
export default async function serverChannelsRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/:id/channels",
    {
      schema: { body: createChannelSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_CHANNELS),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createChannelSchema>;

      const maxPosition = await prisma.channel.aggregate({
        where: { serverId: request.serverId! },
        _max: { position: true },
      });

      const channel = await prisma.channel.create({
        data: {
          serverId: request.serverId!,
          name: body.name,
          type: body.type,
          topic: body.topic ?? null,
          parentId: body.parentId ?? null,
          position: body.position ?? (maxPosition._max.position ?? -1) + 1,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.create",
        targetId: channel.id,
        targetType: "channel",
      });

      const dto = serializeChannel(channel);
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_CREATE, dto);

      reply.code(201);
      return dto;
    },
  );

  fastify.get(
    "/:id/channels",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const channels = await prisma.channel.findMany({
        where: { serverId: request.serverId! },
        orderBy: { position: "asc" },
      });
      // The single most important application of channel overwrites: a channel the member cannot
      // view must not appear in their sidebar at all. Filtering here rather than in the client is
      // the whole point — a client-side filter would still have shipped the channel's name and
      // topic to someone who was configured not to see it.
      const visible = await filterVisibleChannels(request.userId!, request.serverId!, channels);
      return visible.map(serializeChannel);
    },
  );

  // One-time snapshot for members who load the server AFTER others already joined a voice
  // channel — realtime/handlers/voice.ts's VOICE_ROSTER_UPDATE only covers changes from the
  // moment a socket connects onward, so this fills the gap on initial channel-list load.
  fastify.get(
    "/:id/voice-state",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const allVoice = await prisma.channel.findMany({
        where: { serverId: request.serverId!, type: "VOICE" },
        select: { id: true },
      });
      // Same filter as the channel list. Without it the roster would leak who is sitting in a
      // voice channel the member cannot see.
      const voiceChannels = await filterVisibleChannels(request.userId!, request.serverId!, allVoice);
      const io = getIO();
      const result: Record<string, VoiceParticipantDTO[]> = {};
      for (const channel of voiceChannels) {
        const sockets = await io.in(`voice:${channel.id}`).fetchSockets();
        const participants: VoiceParticipantDTO[] = [];
        for (const s of sockets) {
          const otherUserId = s.data.userId as string;
          const user = await prisma.user.findUnique({ where: { id: otherUserId } });
          if (user) participants.push({ userId: otherUserId, socketId: s.id, user: serializeUser(user) });
        }
        if (participants.length > 0) result[channel.id] = participants;
      }
      return result;
    },
  );

  fastify.patch(
    "/:id/channels/reorder",
    {
      schema: { body: reorderSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_CHANNELS),
      ],
    },
    async (request) => {
      const body = request.body as z.infer<typeof reorderSchema>;

      await prisma.$transaction(
        body.order.map((entry) =>
          prisma.channel.update({
            where: { id: entry.id },
            data: { position: entry.position },
          }),
        ),
      );

      const channels = await prisma.channel.findMany({
        where: { serverId: request.serverId! },
        orderBy: { position: "asc" },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.reorder",
        metadata: body,
      });

      const dtos = channels.map(serializeChannel);
      for (const dto of dtos) {
        getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_UPDATE, dto);
      }
      return dtos;
    },
  );
}
