import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Permissions, DEFAULT_EVERYONE_PERMISSIONS } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMember, serializeServer } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { saveProfileImage, deleteProfileImage } from "../../lib/profileImage.js";

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  iconUrl: z.string().url().nullable().optional(),
});

const updateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  iconUrl: z.string().url().nullable().optional(),
  bannerUrl: z.string().url().nullable().optional(),
  accentColor: z.number().int().min(0).max(0xffffff).nullable().optional(),
  systemChannelId: z.string().nullable().optional(),
});

const updateMemberSchema = z.object({
  nickname: z.string().max(32).nullable().optional(),
});

const memberInclude = {
  user: true,
  roles: { select: { roleId: true } },
} as const;

export default async function serversRoutes(fastify: FastifyInstance) {
  fastify.post("/", { schema: { body: createServerSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof createServerSchema>;

    const server = await prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: { name: body.name, iconUrl: body.iconUrl ?? null, ownerId: request.userId! },
      });

      const everyoneRole = await tx.role.create({
        data: {
          serverId: created.id,
          name: "@everyone",
          permissions: DEFAULT_EVERYONE_PERMISSIONS,
          position: 0,
          isDefault: true,
          mentionable: true,
        },
      });

      const generalChannel = await tx.channel.create({
        data: {
          serverId: created.id,
          name: "general",
          type: "TEXT",
          position: 0,
        },
      });

      // New servers previously shipped with zero voice channels — every server owner had to
      // know to manually create one before voice/video was usable at all.
      const defaultVoiceChannels = ["General", "Gaming", "AFK"];
      for (let i = 0; i < defaultVoiceChannels.length; i++) {
        await tx.channel.create({
          data: { serverId: created.id, name: defaultVoiceChannels[i], type: "VOICE", position: i + 1 },
        });
      }

      await tx.membership.create({
        data: { userId: request.userId!, serverId: created.id },
      });

      const updated = await tx.server.update({
        where: { id: created.id },
        data: { systemChannelId: generalChannel.id },
      });

      void everyoneRole;
      return updated;
    });

    reply.code(201);
    return serializeServer(server);
  });

  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.userId! },
      include: { server: true },
      orderBy: { joinedAt: "asc" },
    });
    return memberships.map((m) => serializeServer(m.server));
  });

  fastify.get(
    "/:id",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const server = await prisma.server.findUnique({ where: { id: request.serverId! } });
      if (!server) throw new NotFoundError("Server not found");
      return serializeServer(server);
    },
  );

  fastify.patch(
    "/:id",
    {
      schema: { body: updateServerSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_SERVER),
      ],
    },
    async (request) => {
      const body = request.body as z.infer<typeof updateServerSchema>;
      const server = await prisma.server.update({
        where: { id: request.serverId! },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
          ...(body.bannerUrl !== undefined ? { bannerUrl: body.bannerUrl } : {}),
          ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
          ...(body.systemChannelId !== undefined ? { systemChannelId: body.systemChannelId } : {}),
        },
      });
      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "server.update",
        targetId: server.id,
        targetType: "server",
        metadata: body,
      });
      return serializeServer(server);
    },
  );

  fastify.post(
    "/:id/icon",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_SERVER),
      ],
    },
    async (request) => {
      const iconUrl = await saveProfileImage(
        request.serverId!,
        "server-icons",
        "serverIcon",
        await request.file(),
        "Icon",
      );
      const previous = await prisma.server.findUnique({
        where: { id: request.serverId! },
        select: { iconUrl: true },
      });
      const server = await prisma.server.update({ where: { id: request.serverId! }, data: { iconUrl } });
      await deleteProfileImage(previous?.iconUrl);
      return serializeServer(server);
    },
  );

  fastify.post(
    "/:id/banner",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_SERVER),
      ],
    },
    async (request) => {
      const bannerUrl = await saveProfileImage(
        request.serverId!,
        "server-banners",
        "serverBanner",
        await request.file(),
        "Banner",
      );
      const previous = await prisma.server.findUnique({
        where: { id: request.serverId! },
        select: { bannerUrl: true },
      });
      const server = await prisma.server.update({ where: { id: request.serverId! }, data: { bannerUrl } });
      await deleteProfileImage(previous?.bannerUrl);
      return serializeServer(server);
    },
  );

  fastify.delete(
    "/:id",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_SERVER),
      ],
    },
    async (request, reply) => {
      const server = await prisma.server.findUnique({ where: { id: request.serverId! } });
      if (!server) throw new NotFoundError("Server not found");
      if (server.ownerId !== request.userId) {
        throw new ForbiddenError("Only the server owner can delete the server");
      }
      await prisma.server.delete({ where: { id: request.serverId! } });
      reply.code(204).send();
    },
  );

  fastify.post(
    "/:id/leave",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request, reply) => {
      const server = await prisma.server.findUnique({ where: { id: request.serverId! } });
      if (!server) throw new NotFoundError("Server not found");
      if (server.ownerId === request.userId) {
        throw new BadRequestError("Owner cannot leave their own server; delete or transfer ownership instead");
      }
      await prisma.membership.delete({
        where: { userId_serverId: { userId: request.userId!, serverId: request.serverId! } },
      });
      reply.code(204).send();
    },
  );

  fastify.get(
    "/:id/members",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const members = await prisma.membership.findMany({
        where: { serverId: request.serverId! },
        include: memberInclude,
        orderBy: { joinedAt: "asc" },
      });
      return members.map(serializeMember);
    },
  );

  fastify.patch(
    "/:id/members/:userId",
    {
      schema: { body: updateMemberSchema },
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_NICKNAMES),
      ],
    },
    async (request) => {
      const { userId: targetUserId } = request.params as { userId: string };
      const body = request.body as z.infer<typeof updateMemberSchema>;

      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId: request.serverId! } },
      });
      if (!membership) throw new NotFoundError("Member not found");

      const updated = await prisma.membership.update({
        where: { id: membership.id },
        data: { ...(body.nickname !== undefined ? { nickname: body.nickname } : {}) },
        include: memberInclude,
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.update",
        targetId: targetUserId,
        targetType: "member",
        metadata: body,
      });

      return serializeMember(updated);
    },
  );

  fastify.delete(
    "/:id/members/:userId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.KICK_MEMBERS),
      ],
    },
    async (request, reply) => {
      const { userId: targetUserId } = request.params as { userId: string };
      const server = await prisma.server.findUnique({ where: { id: request.serverId! } });
      if (server?.ownerId === targetUserId) {
        throw new ForbiddenError("Cannot kick the server owner");
      }

      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId: targetUserId, serverId: request.serverId! } },
      });
      if (!membership) throw new NotFoundError("Member not found");

      await prisma.membership.delete({ where: { id: membership.id } });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "member.kick",
        targetId: targetUserId,
        targetType: "member",
      });

      reply.code(204).send();
    },
  );
}
