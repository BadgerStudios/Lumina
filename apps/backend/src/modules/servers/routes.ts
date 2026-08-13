import type { FastifyInstance } from "fastify";
import { ageVisibilityFilter } from "../parental/visibility.js";
import { z } from "zod";
import { Permissions, DEFAULT_EVERYONE_PERMISSIONS } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializeMember, serializeServer } from "../../lib/serialize.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
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
  description: z.string().max(300).nullable().optional(),
  // Constrained to the same character class as generated invite codes because the two share one
  // namespace — /invite/<code> resolves either. Lowercased on write so `Lumina` and `lumina` cannot
  // both be claimed and then resolve unpredictably.
  vanityCode: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9-]+$/, "Letters, numbers and hyphens only")
    .nullable()
    .optional(),
  verificationLevel: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).optional(),
  explicitContentFilter: z.enum(["DISABLED", "MEMBERS_WITHOUT_ROLES", "ALL_MEMBERS"]).optional(),
  defaultNotificationLevel: z.enum(["ALL", "MENTIONS", "NONE"]).optional(),
  afkChannelId: z.string().nullable().optional(),
  // 60s-1h, matching Discord's ladder. An unbounded value would let an operator set a timeout so
  // long the feature silently never fires.
  afkTimeoutSec: z.number().int().min(60).max(3600).optional(),
  sysJoinMessages: z.boolean().optional(),
  sysLeaveMessages: z.boolean().optional(),
  sysBoostMessages: z.boolean().optional(),
  rulesChannelId: z.string().nullable().optional(),
  /// Opt in to the public Discover surface. MANAGE_SERVER-gated like everything else here.
  discoverable: z.boolean().optional(),
  /// host or host:port of the community's Minecraft server. Validated for SHAPE here; whether the
  /// address is safe to dial is decided at ping time against the resolved IP, where it can't rot.
  minecraftHost: z.string().max(260).regex(/^[a-zA-Z0-9.-]+(:\d{1,5})?$/).nullable().optional(),
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

      // A vanity code shares one namespace with generated invite codes (/invite/<x> resolves
      // either), so claiming one must be refused if an Invite already owns the string.
      const vanity = body.vanityCode !== undefined ? (body.vanityCode?.toLowerCase() ?? null) : undefined;
      if (vanity) {
        const collision = await prisma.invite.findUnique({ where: { code: vanity }, select: { code: true } });
        if (collision) throw new ConflictError("That vanity code is already in use");
      }

      // Every field the schema accepts is persisted. This spread used to stop at five fields while
      // the schema accepted sixteen — description, vanity, verification level, content filter, AFK,
      // system messages and rules channel were all validated, echoed into the audit log below, and
      // then silently dropped. The Moderation and Community settings tabs were no-ops that looked
      // like they saved. A live PATCH-then-read-back proved it before this fix; the same check now
      // lives in verify-discovery.mjs so the two lists cannot drift apart unnoticed again.
      const server = await prisma.server.update({
        where: { id: request.serverId! },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}),
          ...(body.bannerUrl !== undefined ? { bannerUrl: body.bannerUrl } : {}),
          ...(body.accentColor !== undefined ? { accentColor: body.accentColor } : {}),
          ...(body.systemChannelId !== undefined ? { systemChannelId: body.systemChannelId } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(vanity !== undefined ? { vanityCode: vanity } : {}),
          ...(body.verificationLevel !== undefined ? { verificationLevel: body.verificationLevel } : {}),
          ...(body.explicitContentFilter !== undefined ? { explicitContentFilter: body.explicitContentFilter } : {}),
          ...(body.defaultNotificationLevel !== undefined
            ? { defaultNotificationLevel: body.defaultNotificationLevel }
            : {}),
          ...(body.afkChannelId !== undefined ? { afkChannelId: body.afkChannelId } : {}),
          ...(body.afkTimeoutSec !== undefined ? { afkTimeoutSec: body.afkTimeoutSec } : {}),
          ...(body.sysJoinMessages !== undefined ? { sysJoinMessages: body.sysJoinMessages } : {}),
          ...(body.sysLeaveMessages !== undefined ? { sysLeaveMessages: body.sysLeaveMessages } : {}),
          ...(body.sysBoostMessages !== undefined ? { sysBoostMessages: body.sysBoostMessages } : {}),
          ...(body.rulesChannelId !== undefined ? { rulesChannelId: body.rulesChannelId } : {}),
          ...(body.discoverable !== undefined ? { discoverable: body.discoverable } : {}),
          ...(body.minecraftHost !== undefined ? { minecraftHost: body.minecraftHost } : {}),
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
      // Capped. This returned EVERY member of a server with their full user record joined in —
      // fine at nine members, a multi-megabyte response and a memory spike on a 768MB container at
      // ten thousand. The member list is also fetched on every server switch, so the cost is paid
      // constantly rather than once.
      //
      // A hard cap rather than cursor pagination because the client renders this as a single
      // sidebar list and has nowhere to put a "load more" yet; raising it later is a one-line
      // change, whereas an unbounded query that has already OOMed the API is an outage. The count
      // is returned alongside so the UI can say "showing 1000 of 4212" instead of quietly lying.
      const MEMBER_PAGE = 1000;
      const [members, total] = await Promise.all([
        prisma.membership.findMany({
          // Age visibility pushed into the query rather than filtered after: a post-filter would
          // still have loaded every minor's full user record into this process, and the cap above
          // would then be spent on rows about to be discarded.
          where: { serverId: request.serverId!, user: await ageVisibilityFilter(request.userId!) },
          include: memberInclude,
          orderBy: { joinedAt: "asc" },
          take: MEMBER_PAGE,
        }),
        prisma.membership.count({ where: { serverId: request.serverId! } }),
      ]);
      if (total > MEMBER_PAGE) {
        request.log.warn({ serverId: request.serverId, total }, "member list truncated");
      }
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
