import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { requireAuth, requireMembership, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import {
  cacheSkin,
  generateVerifyCode,
  lookupMojangProfile,
  pingMinecraftServer,
} from "./minecraft.js";

const linkSchema = z.object({ username: z.string().min(3).max(16) });
const verifySchema = z.object({ code: z.string().min(4).max(12), uuid: z.string().min(32).max(36) });

const STATUS_CACHE_TTL_S = 60;

function serializeLink(link: {
  provider: string;
  externalId: string;
  externalName: string;
  skinPath: string | null;
  verified: boolean;
  verifyCode?: string;
  createdAt: Date;
}, includeCode: boolean) {
  return {
    provider: link.provider,
    externalId: link.externalId,
    externalName: link.externalName,
    skinUrl: link.skinPath,
    verified: link.verified,
    // The verify code is a secret between the user and the plugin they'll type it into — it goes
    // to its owner and to nobody else's profile view.
    ...(includeCode ? { verifyCode: link.verifyCode } : {}),
    createdAt: link.createdAt.toISOString(),
  };
}

/** Mounted under /api/game. */
export default async function gameRoutes(fastify: FastifyInstance) {
  fastify.get("/links", { preHandler: [requireAuth] }, async (request) => {
    const links = await prisma.gameLink.findMany({ where: { userId: request.userId! } });
    return links.map((l) => serializeLink(l, true));
  });

  fastify.post(
    "/minecraft/link",
    {
      schema: { body: linkSchema },
      // Mojang lookups on someone else's rate budget — keep ours polite.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { username } = request.body as z.infer<typeof linkSchema>;
      const profile = await lookupMojangProfile(username);
      const skinPath = await cacheSkin(profile.uuid, profile.skinUrl).catch(() => null);

      // Relinking replaces the claim and RESETS verification: the new username may be a different
      // person's account, and verification vouches for an identity, not for the row.
      const link = await prisma.gameLink.upsert({
        where: { userId_provider: { userId: request.userId!, provider: "MINECRAFT" } },
        create: {
          userId: request.userId!,
          provider: "MINECRAFT",
          externalId: profile.uuid,
          externalName: profile.name,
          skinPath,
          verifyCode: generateVerifyCode(),
        },
        update: {
          externalId: profile.uuid,
          externalName: profile.name,
          skinPath,
          verified: false,
          verifyCode: generateVerifyCode(),
        },
      });
      reply.code(201);
      return serializeLink(link, true);
    },
  );

  fastify.delete("/minecraft/link", { preHandler: [requireAuth] }, async (request, reply) => {
    await prisma.gameLink.deleteMany({ where: { userId: request.userId!, provider: "MINECRAFT" } });
    reply.code(204).send();
  });

  /**
   * The plugin-facing half of verification — the seed of the "server owners ship a pack" model.
   *
   * Called by a Minecraft server plugin with a BOT token (requireAuth already accepts those; the
   * whole point of folding bot auth into the main preHandler back in Phase 3 was that new APIs
   * like this one get bot support for free). The player runs `/lumina link <code>` in-game; the
   * plugin has cryptographic certainty of that player's UUID from the session, and reports both.
   * The match of (code the user was shown) to (UUID the plugin witnessed) is the proof.
   */
  fastify.post(
    "/minecraft/verify",
    { schema: { body: verifySchema }, preHandler: [requireAuth] },
    async (request) => {
      // Plugin-only: the whole proof is that a trusted server plugin WITNESSED the UUID in-game and
      // reports it. requireAuth also accepts ordinary human sessions, so without this gate a user
      // could just call /minecraft/link {username:"Notch"} then /minecraft/verify with their own
      // code + Notch's public UUID and self-verify a link to an account they don't own. Requiring a
      // bot principal enforces the documented contract (the plugin authenticates with a bot token).
      // (Residual: a user who stands up their own bot could still call this; fully closing that
      // needs binding verification to the specific game-server agent, which is a plugin-contract
      // change — tracked separately.)
      const caller = await prisma.user.findUnique({ where: { id: request.userId! }, select: { isBot: true } });
      if (!caller?.isBot) throw new ForbiddenError("Minecraft verification is performed by the server plugin, not a user session");

      const { code, uuid } = request.body as z.infer<typeof verifySchema>;
      const normalized = uuid.replace(/-/g, "").toLowerCase();

      const link = await prisma.gameLink.findUnique({ where: { verifyCode: code.trim().toUpperCase() } });
      if (!link || link.provider !== "MINECRAFT") throw new NotFoundError("Unknown code");
      if (link.externalId.toLowerCase() !== normalized) {
        // The single check that makes verification mean something: a code alone proves you saw a
        // code; the UUID observed in-game proves who was holding it.
        throw new BadRequestError("That code belongs to a different Minecraft account");
      }

      const updated = await prisma.gameLink.update({ where: { id: link.id }, data: { verified: true } });
      return { verified: true, userId: updated.userId, externalName: updated.externalName };
    },
  );

  /** Public-ish profile chip: which Minecraft identity does this Lumina user carry. */
  fastify.get("/minecraft/profile/:userId", { preHandler: [requireAuth] }, async (request) => {
    const { userId } = request.params as { userId: string };
    const link = await prisma.gameLink.findUnique({
      where: { userId_provider: { userId, provider: "MINECRAFT" } },
    });
    if (!link) return { linked: false };
    return { linked: true, ...serializeLink(link, false) };
  });

  /**
   * Live status of the community's Minecraft server. Membership-gated (the address is the
   * server's own setting, not public data) and Redis-cached so a busy sidebar polls us, not them.
   */
  fastify.get(
    "/minecraft/status/:serverId",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("serverId"))] },
    async (request) => {
      const server = await prisma.server.findUnique({
        where: { id: request.serverId! },
        select: { minecraftHost: true },
      });
      if (!server?.minecraftHost) return { configured: false };

      // The HOST is part of the key. Keyed by server alone, changing the address served the OLD
      // address's cached answer for up to a minute — the verify suite's positive control caught
      // exactly that: an unresolvable host's "offline" was returned for a reachable one.
      const cacheKey = `mc:status:${request.serverId}:${server.minecraftHost}`;
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) return { configured: true, host: server.minecraftHost, ...JSON.parse(cached) };

      const status = await pingMinecraftServer(server.minecraftHost);
      await redis.set(cacheKey, JSON.stringify(status), "EX", STATUS_CACHE_TTL_S).catch(() => undefined);
      return { configured: true, host: server.minecraftHost, ...status };
    },
  );
}
