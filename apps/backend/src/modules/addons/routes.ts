import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { manifestSchema, compareVersions, requiresBot, type AddonManifest } from "./manifest.js";
import { invalidateServerAddons } from "./runtime.js";

/** Constant-time equality for two hex hash strings of expected-equal length. */
function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}


/**
 * Addons. Mounted under /api/addons, plus the per-server install routes.
 *
 * Publishing is the interesting half. The request "any CLI can deploy an addon" is, taken
 * literally, remote code execution as a feature — so what a CLI can actually deploy here is a
 * manifest, validated against a fixed vocabulary (see manifest.ts) before it is ever stored.
 *
 * The CLI authenticates as an **Application** using its existing client id and secret, rather than
 * inventing a second credential system. That means publishing is already tied to an owner, already
 * revocable by rotating the secret, and already gives an addon the identity it needs to speak as
 * (the Application's bot user).
 */

const publishSchema = z.object({
  clientId: z.string().min(1),
  /** Either the OAuth client secret or the application's bot token — see verifyApplication. */
  clientSecret: z.string().min(1),
  manifest: manifestSchema,
});

export default async function addonRoutes(fastify: FastifyInstance) {
  /**
   * Publish or update an addon. This is the CLI's endpoint.
   *
   * Rate-limited harder than a normal route: it is unauthenticated in the session sense (no
   * bearer token), so it is reachable by anyone who wants to guess client secrets.
   */
  fastify.post("/publish", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = publishSchema.safeParse(request.body);
    if (!parsed.success) {
      // The zod issues are returned deliberately: a manifest is written by a developer at a
      // terminal, and "invalid manifest" with no detail makes the format unusable.
      throw new BadRequestError(
        `Manifest rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    }
    const { clientId, clientSecret, manifest } = parsed.data;

    const app = await prisma.application.findUnique({
      where: { id: clientId },
      include: { botUser: { select: { id: true } } },
    });
    // Either credential is accepted, and the reason is a real papercut rather than convenience:
    // generating an OAuth client secret requires a redirect URI first, which an addon that only
    // reacts to keywords will never have. Making someone invent a redirect URI they don't use, to
    // get a secret they only need for publishing, is the kind of step that makes a feature feel
    // hostile. The bot token is per-application and revocable in exactly the same way.
    const presented = hashRefreshToken(clientSecret);
    // Constant-time compare, matching the timingSafeEqual convention used for the OAuth/webhook
    // credential checks elsewhere (both hashes are equal-length hex).
    const secretMatch = !!app?.clientSecretHash && safeHashEqual(presented, app.clientSecretHash);
    const botMatch = !!app?.botTokenHash && safeHashEqual(presented, app.botTokenHash);
    const authorized = secretMatch || botMatch;
    if (!app || !authorized) {
      // One message for both "no such app" and "wrong secret", so this can't be used to enumerate
      // which client ids exist.
      throw new ForbiddenError("Invalid client credentials");
    }

    // A `reply` action needs an identity to post as, and the only honest one is the publishing
    // Application's bot. Refused at publish time so the author finds out at their terminal rather
    // than discovering later that half their addon silently does nothing.
    if (requiresBot(manifest) && !app.botUser) {
      throw new BadRequestError(
        "This addon replies to messages, which needs a bot user. Create one for this application first.",
      );
    }

    const existing = await prisma.addon.findUnique({ where: { slug: manifest.slug } });

    if (existing) {
      if (existing.applicationId !== app.id) throw new ConflictError("That slug belongs to another application");
      // Versions only ever move forwards. A stolen secret can then publish something new and
      // visible, but cannot silently roll every install back to an older manifest.
      if (compareVersions(manifest.version, existing.version) <= 0) {
        throw new ConflictError(
          `Version ${manifest.version} is not newer than the published ${existing.version}`,
        );
      }
    }

    const addon = await prisma.addon.upsert({
      where: { slug: manifest.slug },
      create: {
        slug: manifest.slug,
        name: manifest.name,
        description: manifest.description ?? null,
        version: manifest.version,
        manifest: manifest as unknown as object,
        applicationId: app.id,
        authorId: app.ownerId,
      },
      update: {
        name: manifest.name,
        description: manifest.description ?? null,
        version: manifest.version,
        manifest: manifest as unknown as object,
      },
    });

    // A new version has to reach servers that already installed it. The runtime caches installs
    // per server, so without this a published fix rolls out only as the TTL lapses — five minutes
    // of an author watching their fix appear to do nothing.
    const affected = await prisma.serverAddon.findMany({
      where: { addonId: addon.id },
      select: { serverId: true },
    });
    await Promise.all(affected.map((a) => invalidateServerAddons(a.serverId)));

    reply.code(existing ? 200 : 201);
    return serializeAddon(addon);
  });

  /** The public directory. No auth: an addon manifest is published documentation, and someone
   * deciding whether to install one should be able to read it first. */
  fastify.get("/", async (request) => {
    const { q } = request.query as { q?: string };
    const addons = await prisma.addon.findMany({
      where: q
        ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] }
        : undefined,
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return addons.map(serializeAddon);
  });

  fastify.get("/:slug", async (request) => {
    const { slug } = request.params as { slug: string };
    const addon = await prisma.addon.findUnique({ where: { slug } });
    if (!addon) throw new NotFoundError("Addon not found");
    return { ...serializeAddon(addon), manifest: addon.manifest };
  });
}

/** Mounted under /api/servers/:id/addons — installing is a server-management action, so it lives
 * behind the same permission as everything else in server settings. */
export async function serverAddonRoutes(fastify: FastifyInstance) {
  const guard = {
    preHandler: [
      requireAuth,
      requireMembership(resolveServerId.fromParam("id")),
      requirePermission(Permissions.MANAGE_SERVER),
    ],
  };

  fastify.get("/", guard, async (request) => {
    const installs = await prisma.serverAddon.findMany({
      where: { serverId: request.serverId! },
      include: {
        addon: { include: { application: { include: { botUser: { select: { id: true, username: true } } } } } },
        installedBy: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return installs.map((i) => ({
      id: i.id,
      enabled: i.enabled,
      installedAt: i.createdAt.toISOString(),
      installedBy: i.installedBy,
      addon: { ...serializeAddon(i.addon), manifest: i.addon.manifest },
      // Surfaced rather than silently degraded: an addon whose reply actions can't run should say
      // so in the UI, not just do nothing.
      botUser: i.addon.application?.botUser ?? null,
      needsBot: requiresBot(i.addon.manifest as unknown as AddonManifest),
    }));
  });

  fastify.post("/", guard, async (request, reply) => {
    const { slug } = request.body as { slug?: string };
    if (!slug) throw new BadRequestError("Which addon?");

    const addon = await prisma.addon.findUnique({ where: { slug } });
    if (!addon) throw new NotFoundError("Addon not found");

    const install = await prisma.serverAddon.upsert({
      where: { serverId_addonId: { serverId: request.serverId!, addonId: addon.id } },
      create: { serverId: request.serverId!, addonId: addon.id, installedById: request.userId! },
      // Installing something already installed re-enables it rather than erroring — that is what
      // the person clicking "Install" meant either way.
      update: { enabled: true },
    });

    // An addon that replies posts as its application's bot, and that bot can only post in a server
    // it belongs to. Without this the install succeeds, the automation matches, and the reply
    // silently never appears — the exact "backend built, nothing calls it" failure this codebase
    // has hit repeatedly. Joining the bot is part of installing, not a second step nobody knows
    // about; it joins with @everyone permissions like any other invited bot, and the UI names it
    // before you click.
    const botUserId = await botUserFor(addon.id);
    if (botUserId) {
      await prisma.membership.upsert({
        where: { userId_serverId: { userId: botUserId, serverId: request.serverId! } },
        create: { userId: botUserId, serverId: request.serverId! },
        update: {},
      });
    }

    await invalidateServerAddons(request.serverId!);

    reply.code(201);
    return { id: install.id, enabled: install.enabled, addon: serializeAddon(addon), botJoined: botUserId !== null };
  });

  fastify.patch("/:installId", guard, async (request) => {
    const { installId } = request.params as { installId: string };
    const { enabled } = request.body as { enabled?: boolean };
    if (typeof enabled !== "boolean") throw new BadRequestError("enabled must be true or false");

    const install = await assertInstall(request, installId);
    const updated = await prisma.serverAddon.update({ where: { id: install.id }, data: { enabled } });
    await invalidateServerAddons(request.serverId!);
    return { id: updated.id, enabled: updated.enabled };
  });

  fastify.delete("/:installId", guard, async (request, reply) => {
    const { installId } = request.params as { installId: string };
    const install = await assertInstall(request, installId);
    await prisma.serverAddon.delete({ where: { id: install.id } });
    await invalidateServerAddons(request.serverId!);
    reply.code(204).send();
  });
}

/** The bot an addon needs to speak as, or null when it never speaks. Resolved from the stored
 * manifest rather than trusted from the request. */
async function botUserFor(addonId: string): Promise<string | null> {
  const addon = await prisma.addon.findUnique({
    where: { id: addonId },
    include: { application: { include: { botUser: { select: { id: true } } } } },
  });
  if (!addon) return null;
  if (!requiresBot(addon.manifest as unknown as AddonManifest)) return null;
  return addon.application?.botUser?.id ?? null;
}

/** Scopes an install id to the server in the URL. Without this, a moderator of any server could
 * uninstall an addon from any other server by guessing an id. */
async function assertInstall(request: FastifyRequest, installId: string) {
  const install = await prisma.serverAddon.findUnique({ where: { id: installId } });
  if (!install || install.serverId !== request.serverId) throw new NotFoundError("Addon isn't installed here");
  return install;
}

function serializeAddon(addon: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  updatedAt: Date;
}) {
  return {
    id: addon.id,
    slug: addon.slug,
    name: addon.name,
    description: addon.description,
    version: addon.version,
    updatedAt: addon.updatedAt.toISOString(),
  };
}
