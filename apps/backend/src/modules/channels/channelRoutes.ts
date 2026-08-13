import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeChannel } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { checkRoleHierarchy } from "../../permissions/permissionService.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { getIO } from "../../realtime/io.js";

/** Bitfields cross the wire as decimal strings — a permission bitfield is a BigInt and JSON
 * numbers lose precision above 2^53, which this catalogue will eventually exceed. */
const upsertOverwriteSchema = z.object({
  targetType: z.enum(["ROLE", "USER"]),
  allow: z.string().regex(/^\d+$/),
  deny: z.string().regex(/^\d+$/),
});

function serializeOverwrite(row: { channelId: string; targetType: string; targetId: string; allow: bigint; deny: bigint }) {
  return {
    channelId: row.channelId,
    targetType: row.targetType,
    targetId: row.targetId,
    allow: row.allow.toString(),
    deny: row.deny.toString(),
  };
}

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

  // ---------------------------------------------------------------- permission overwrites
  //
  // All three routes gate on MANAGE_ROLES rather than MANAGE_CHANNELS. Editing an overwrite is
  // granting or revoking permissions, so it belongs with the permission-granting bit — otherwise
  // anyone who could rename a channel could also grant themselves MANAGE_SERVER inside it.

  fastify.get(
    "/:id/overwrites",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromChannelParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await prisma.channelPermissionOverwrite.findMany({ where: { channelId: id } });
      return rows.map(serializeOverwrite);
    },
  );

  fastify.put(
    "/:id/overwrites/:targetId",
    {
      schema: { body: upsertOverwriteSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromChannelParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request) => {
      const { id, targetId } = request.params as { id: string; targetId: string };
      const body = request.body as z.infer<typeof upsertOverwriteSchema>;
      const allow = BigInt(body.allow);
      const deny = BigInt(body.deny);

      // A bit set in both fields is contradictory, and the resolution order would silently pick a
      // winner. Rejecting it keeps the stored state a faithful record of what the admin chose.
      if ((allow & deny) !== 0n) {
        throw new BadRequestError("A permission cannot be both allowed and denied");
      }

      // Escalation guard, mirroring checkRoleHierarchy for roles: without it, anyone with
      // MANAGE_ROLES in a channel could grant themselves ADMINISTRATOR there and inherit the
      // bypass that skips overwrites entirely — which is server-wide authority obtained through a
      // channel-scoped permission.
      const forbidden = Permissions.ADMINISTRATOR | Permissions.MANAGE_SERVER;
      if (((allow | deny) & forbidden) !== 0n) {
        throw new BadRequestError("Administrator and Manage Server cannot be set per channel");
      }

      if (body.targetType === "ROLE") {
        const role = await prisma.role.findUnique({ where: { id: targetId }, select: { serverId: true, position: true } });
        if (!role || role.serverId !== request.serverId) throw new NotFoundError("Role not found");
        await checkRoleHierarchy(request.userId!, request.serverId!, role.position);
      } else {
        const membership = await prisma.membership.findUnique({
          where: { userId_serverId: { userId: targetId, serverId: request.serverId! } },
          select: { id: true },
        });
        if (!membership) throw new NotFoundError("Member not found");
      }

      const row = await prisma.channelPermissionOverwrite.upsert({
        where: { channelId_targetType_targetId: { channelId: id, targetType: body.targetType, targetId } },
        create: { channelId: id, targetType: body.targetType, targetId, allow, deny },
        update: { allow, deny },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.overwrite.update",
        targetId: id,
        targetType: "channel",
        metadata: { targetType: body.targetType, targetId, allow: body.allow, deny: body.deny },
      });

      // Every member of the server, not just those who can see the channel: this is precisely the
      // event that can make a channel newly visible to someone, and a client that was excluded
      // from the room would never learn it now has access.
      getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_OVERWRITES_UPDATE, { channelId: id });
      return serializeOverwrite(row);
    },
  );

  fastify.delete(
    "/:id/overwrites/:targetId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromChannelParam("id")),
        requirePermission(Permissions.MANAGE_ROLES),
      ],
    },
    async (request, reply) => {
      const { id, targetId } = request.params as { id: string; targetId: string };
      await prisma.channelPermissionOverwrite.deleteMany({ where: { channelId: id, targetId } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "channel.overwrite.delete",
        targetId: id,
        targetType: "channel",
        metadata: { targetId },
      });

      getIO().to(`server:${request.serverId}`).emit(ServerEvents.CHANNEL_OVERWRITES_UPDATE, { channelId: id });
      reply.code(204).send();
    },
  );
}
