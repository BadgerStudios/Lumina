import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { hashRefreshToken, verifyAccessToken } from "../lib/jwt.js";
import { BannedError, ForbiddenError, NotFoundError, UnauthorizedError } from "../lib/errors.js";
import { checkPermission } from "../permissions/permissionService.js";
import { prisma } from "../db/prisma.js";
import { hasPlatformRole } from "../lib/platformRole.js";
import { isUserBanned } from "../modules/bans/service.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    serverId?: string;
  }
}

/**
 * Verifies either a Bearer access token (human sessions) or a Bot token (see
 * modules/applications/service.ts) and sets request.userId either way. Deliberately the ONLY
 * place bot auth is handled — every downstream preHandler/service (requireMembership,
 * checkPermission, message creation, etc.) just sees a userId and treats a bot exactly like any
 * other member, no parallel bot-permission system. Bot tokens are hashed at rest the same way
 * refresh tokens are (see lib/jwt.ts hashRefreshToken), reused here rather than duplicated.
 */
export const requireAuth: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
  const header = request.headers.authorization;
  if (!header) throw new UnauthorizedError("Missing authorization header");

  if (header.startsWith("Bot ")) {
    const token = header.slice("Bot ".length);
    const botTokenHash = hashRefreshToken(token);
    const application = await prisma.application.findFirst({
      where: { botTokenHash },
      select: { botUser: { select: { id: true } } },
    });
    if (!application?.botUser) throw new UnauthorizedError("Invalid bot token");
    request.userId = application.botUser.id;
    return;
  }

  if (!header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  const token = header.slice("Bearer ".length);
  let userId: string;
  try {
    const payload = verifyAccessToken(token);
    userId = payload.sub;
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }

  // Platform ban check on every authenticated request. Backed by a 30s Redis cache (see
  // modules/bans/service.ts) so this costs one Redis GET, not a database round trip — without it a
  // banned user would keep full access until their 15-minute access token expired.
  if (await isUserBanned(userId)) {
    throw new BannedError({
      reason: "Your account has been banned from this platform.",
      scope: "ACCOUNT",
      expiresAt: null,
    });
  }

  request.userId = userId;
};

export type ServerIdResolver = (request: FastifyRequest) => Promise<string> | string;

/**
 * Common resolvers for turning a route's params into a serverId, since some
 * routes only carry a channelId / roleId / invite code, not the server id
 * directly.
 */
export const resolveServerId = {
  fromParam:
    (paramName = "id"): ServerIdResolver =>
    (request) => {
      const value = (request.params as Record<string, string>)[paramName];
      if (!value) throw new NotFoundError("Server not found");
      return value;
    },
  fromChannelParam:
    (paramName = "id"): ServerIdResolver =>
    async (request) => {
      const channelId = (request.params as Record<string, string>)[paramName];
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
      if (!channel) throw new NotFoundError("Channel not found");
      return channel.serverId;
    },
  fromRoleParam:
    (paramName = "id"): ServerIdResolver =>
    async (request) => {
      const roleId = (request.params as Record<string, string>)[paramName];
      const role = await prisma.role.findUnique({ where: { id: roleId }, select: { serverId: true } });
      if (!role) throw new NotFoundError("Role not found");
      return role.serverId;
    },
  fromInviteParam:
    (paramName = "code"): ServerIdResolver =>
    async (request) => {
      const code = (request.params as Record<string, string>)[paramName];
      const invite = await prisma.invite.findUnique({ where: { code }, select: { serverId: true } });
      if (!invite) throw new NotFoundError("Invite not found");
      return invite.serverId;
    },
  fromMessageParam:
    (paramName = "id"): ServerIdResolver =>
    async (request) => {
      const messageId = (request.params as Record<string, string>)[paramName];
      const message = await prisma.message.findUnique({
        where: { id: BigInt(messageId) },
        select: { channel: { select: { serverId: true } } },
      });
      if (!message?.channel) throw new NotFoundError("Message not found");
      return message.channel.serverId;
    },
  fromWebhookParam:
    (paramName = "id"): ServerIdResolver =>
    async (request) => {
      const webhookId = (request.params as Record<string, string>)[paramName];
      const webhook = await prisma.webhook.findUnique({ where: { id: webhookId }, select: { channel: { select: { serverId: true } } } });
      if (!webhook) throw new NotFoundError("Webhook not found");
      return webhook.channel.serverId;
    },
};

/**
 * 404 if the server doesn't exist, 403 if the authenticated user is not a
 * member. Resolves serverId via the supplied resolver and stashes it on
 * request.serverId for downstream requirePermission checks.
 */
export function requireMembership(resolver: ServerIdResolver): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.userId) throw new UnauthorizedError();
    const serverId = await resolver(request);

    const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!server) throw new NotFoundError("Server not found");

    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId: request.userId, serverId } },
      select: { id: true },
    });
    if (!membership) throw new ForbiddenError("Not a member of this server");

    request.serverId = serverId;
  };
}

/** Must run after requireMembership (needs request.serverId set). */
export function requirePermission(bit: bigint): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.userId || !request.serverId) throw new UnauthorizedError();
    await checkPermission(request.userId, request.serverId, bit);
  };
}

/**
 * Platform-wide authority gate — deliberately NOT built on requirePermission. Every permission bit
 * in this codebase is evaluated against a specific server via Membership/Role, which simply cannot
 * express authority over the global video feed or the platform ban list: that content belongs to no
 * server, so there is no serverId to check a bitfield against. This reads User.platformRole instead.
 *
 * Runs after requireAuth. Re-reads the role from the database on every request rather than trusting
 * an access-token claim, so demoting someone takes effect immediately instead of lingering for the
 * remainder of a 15-minute token TTL.
 *
 * Bot tokens authenticate through requireAuth too, so a bot User row with an elevated role would
 * otherwise pass — nothing grants it today (bootstrap is email-based and bot emails are synthesized),
 * but that's why this checks isBot explicitly rather than assuming it can't happen.
 */
function requirePlatformRole(required: "STAFF" | "OWNER" | "MASTER"): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.userId) throw new UnauthorizedError();
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { platformRole: true, isBot: true },
    });
    if (!user || user.isBot || !hasPlatformRole(user.platformRole, required)) {
      throw new ForbiddenError(
        required === "MASTER" ? "Master account only" : required === "OWNER" ? "Owner only" : "Staff only",
      );
    }
  };
}

/** STAFF or above — the video review queue and everything else moderators touch. */
export const requireStaff = requirePlatformRole("STAFF");

/** OWNER or above — the owner dashboard, user management, and platform bans. */
export const requireOwner = requirePlatformRole("OWNER");

/** MASTER only — role granting, platform configuration, and destructive actions. Nothing below the
 * master account reaches these, including owners. */
export const requireMaster = requirePlatformRole("MASTER");

export default fp(async (fastify) => {
  fastify.decorateRequest("userId", undefined);
  fastify.decorateRequest("serverId", undefined);
});
