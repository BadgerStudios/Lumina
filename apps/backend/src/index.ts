import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import path from "node:path";
import fs from "node:fs/promises";
import { env } from "./config/env.js";
import { AppError, BannedError, BlockedError } from "./lib/errors.js";
import { getBlockReason } from "@lumina/shared";
import { initIO } from "./realtime/io.js";

import cookiePlugin from "./plugins/cookie.js";
import corsPlugin from "./plugins/cors.js";
import helmetPlugin from "./plugins/helmet.js";
import multipartPlugin from "./plugins/multipart.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import sensiblePlugin from "./plugins/sensible.js";
import authenticatePlugin from "./plugins/authenticate.js";

import authRoutes from "./modules/auth/routes.js";
import usersRoutes from "./modules/users/routes.js";
import opsRoutes from "./modules/ops/routes.js";
import adRoutes from "./modules/ads/routes.js";
import addonRoutes, { serverAddonRoutes } from "./modules/addons/routes.js";
import serversRoutes from "./modules/servers/routes.js";
import moderationRoutes from "./modules/moderation/routes.js";
import serverChannelsRoutes from "./modules/channels/serverRoutes.js";
import channelRoutes from "./modules/channels/channelRoutes.js";
import threadRoutes from "./modules/threads/routes.js";
import parentalRoutes from "./modules/parental/routes.js";
import discoveryRoutes from "./modules/discovery/routes.js";
import gameRoutes from "./modules/game/routes.js";
import activityRoutes from "./modules/activities/routes.js";
import economyRoutes, { seedGifts } from "./modules/economy/routes.js";
import { seedPolicies } from "./modules/economy/service.js";
import inboxRoutes from "./modules/inbox/routes.js";
import xpRoutes from "./modules/xp/routes.js";
import serverRolesRoutes from "./modules/roles/serverRoutes.js";
import autoModServerRoutes from "./modules/automod/serverRoutes.js";
import roleRoutes from "./modules/roles/roleRoutes.js";
import serverInvitesRoutes from "./modules/invites/serverRoutes.js";
import inviteRoutes from "./modules/invites/inviteRoutes.js";
import channelMessagesRoutes from "./modules/messages/channelMessagesRoutes.js";
import dmMessagesRoutes from "./modules/messages/dmMessagesRoutes.js";
import messageRoutes from "./modules/messages/messageRoutes.js";
import dmRoutes from "./modules/dm/routes.js";
import searchRoutes from "./modules/search/routes.js";
import uploadsRoutes from "./modules/uploads/routes.js";
import channelReadRoutes from "./modules/readState/channelReadRoutes.js";
import serverUnreadRoutes from "./modules/readState/serverUnreadRoutes.js";
import notificationRoutes from "./modules/notifications/routes.js";
import applicationRoutes from "./modules/applications/routes.js";
import channelWebhookRoutes from "./modules/webhooks/channelWebhookRoutes.js";
import serverWebhookRoutes from "./modules/webhooks/serverWebhookRoutes.js";
import webhookRoutes from "./modules/webhooks/webhookRoutes.js";
import friendRoutes from "./modules/friends/routes.js";
import voiceRoutes from "./modules/voice/routes.js";
import oauth2Routes from "./modules/oauth2/routes.js";
import pushRoutes from "./modules/push/routes.js";
import metaRoutes from "./modules/meta/routes.js";
import videoRoutes from "./modules/videos/routes.js";
import staffRoutes from "./modules/staff/routes.js";
import reportRoutes from "./modules/staff/reports.js";
import videoSocialRoutes from "./modules/videos/social.js";
import feedRoutes from "./modules/feed/routes.js";
import ownerRoutes from "./modules/owner/routes.js";
import banRoutes from "./modules/bans/routes.js";
import billingRoutes from "./modules/billing/routes.js";
import emojiRoutes from "./modules/emoji/routes.js";
import storeRoutes from "./modules/store/routes.js";
import downloadRoutes from "./modules/metrics/downloadRoutes.js";
import masterRoutes from "./modules/master/routes.js";
import lookupRoutes from "./modules/lookup/routes.js";
import ageRoutes from "./modules/age/routes.js";
import siteRoutes from "./modules/site/routes.js";
import stickerRoutes from "./modules/stickers/routes.js";
import soundboardRoutes from "./modules/soundboard/routes.js";
import pollRoutes from "./modules/polls/routes.js";
import interactionRoutes from "./modules/interactions/routes.js";
import templateRoutes from "./modules/templates/routes.js";
import { registerMetricsHooks, registerMetricsRoute } from "./modules/metrics/prometheus.js";

async function main() {
  await fs.mkdir(env.UPLOADS_DIR, { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "avatars"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "banners"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "server-icons"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "server-banners"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "attachments"), { recursive: true });
  // `emojis` was missing here AND from the static registrations below, which meant every custom
  // emoji uploaded since that feature shipped resolved to the SPA's index.html instead of an image.
  // The upload succeeded, the row was written, and the picture was simply broken everywhere.
  await fs.mkdir(path.join(env.UPLOADS_DIR, "emojis"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "stickers"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "sounds"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "game-skins"), { recursive: true });

  const fastify = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "info" : "warn",
    },
    trustProxy: true,
  });

  // Production logs at `warn`, which meant no request left any trace at all — a user reporting
  // "it won't let me log in" produced literally nothing to look at, and answering it took twenty
  // manual probes. This logs only responses that actually failed, at warn so they survive the
  // production level. No request bodies and no credentials: method, route, status, and a client
  // IP, which is what distinguishes a rate-limited login (429) from a rejected one (401).
  fastify.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) return;
    request.log.warn(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        ip: request.ip,
        userId: request.userId ?? null,
        ms: Math.round(reply.elapsedTime),
      },
      "request failed",
    );
  });

  fastify.setErrorHandler((error: Error & { statusCode?: number; issues?: unknown }, request, reply) => {
    // BannedError carries structured details (reason/expiry/appeal state) that the client's ban
    // screen renders — checked before the generic AppError branch, which would drop them.
    if (error instanceof BannedError) {
      reply.code(error.statusCode).send({ error: error.message, code: error.code, details: error.details });
      return;
    }
    // Resolves the catalogue entry server-side so the client never needs its own copy of the
    // wording, and staffNote is never included — it's internal by design.
    if (error instanceof BlockedError) {
      const reason = getBlockReason(error.reasonCode);
      reply.code(error.statusCode).send({
        error: reason?.userMessage || "Access denied",
        code: "BLOCKED",
        reasonCode: error.reasonCode,
        details: reason
          ? { title: reason.title, severity: reason.severity, selfResolvable: reason.selfResolvable }
          : undefined,
      });
      return;
    }
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    // zod validation errors — raised two different ways depending on the route, and both need
    // to land in the exact same response shape the frontend/tests already expect:
    //  1. A route with no attached `schema.body` still validates manually inside its handler
    //     via `someSchema.parse(request.body)`, which throws a real ZodError directly.
    //  2. A route WITH `schema.body` (see fastify-type-provider-zod wiring above, used so
    //     /api/docs shows real request shapes) fails inside Fastify's own validation step
    //     instead — the thrown error isn't a ZodError, it's Fastify's generic validation error
    //     shape with a `.validation` array of per-issue objects (each one wrapping the original
    //     ZodIssue in `.params.issue`). Detected via the library's own type guard rather than
    //     duck-typing, and reshaped back into `error.issues`-equivalent form so both paths
    //     produce byte-identical responses.
    if (error?.name === "ZodError") {
      reply.code(400).send({ error: "Validation failed", code: "VALIDATION_ERROR", details: error.issues });
      return;
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = (error as { validation: Array<{ params: { issue: unknown } }> }).validation.map((v) => v.params.issue);
      reply.code(400).send({ error: "Validation failed", code: "VALIDATION_ERROR", details });
      return;
    }
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(statusCode).send({ error: statusCode === 500 ? "Internal server error" : error.message });
  });

  registerMetricsHooks(fastify);

  await fastify.register(sensiblePlugin);
  await fastify.register(helmetPlugin);
  await fastify.register(corsPlugin);
  await fastify.register(cookiePlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(multipartPlugin);
  await fastify.register(authenticatePlugin);

  // Auto-generated from the live route table (every fastify.get/post/etc below), not
  // hand-maintained — every route registered from here on is picked up automatically, so this
  // can never silently drift out of sync with what the API actually does. Request body schemas
  // ARE wired in for real (see fastify-type-provider-zod below): every route's existing zod
  // schema is attached as `schema.body`, so /api/docs shows genuine field-level request shapes,
  // not just endpoint names. Response schemas are deliberately NOT attached — this library's
  // serializer would silently DROP any response field not declared in `schema.response`, and
  // every DTO in @lumina/shared is hand-built by serializeX() functions, not derived from a zod
  // schema at all; writing a parallel zod mirror of every DTO risked introducing exactly the
  // kind of silent-field-loss bug that's worse than the docs gap it would close. Response shapes
  // are fully documented in TypeScript instead, at packages/shared/src/types.ts.
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  /**
   * Route prefixes kept OUT of the published spec.
   *
   * The docs are deliberately public — Lumina has a developer platform, and someone writing a bot
   * should be able to read the API without an account. That argument does not extend to the
   * administrative surface: the spec was publishing 47 privileged paths, complete with parameter
   * names and request schemas, for /api/master/grant, /api/owner/users/{id}/role, /api/ops/* and
   * the staff review queue.
   *
   * None of those are reachable without the right role — this is not a hole. It is free
   * reconnaissance: an exact map of what to aim a stolen owner token at, and a diff-able record of
   * which privileged endpoints exist and when they appear. Nothing is gained by publishing it,
   * since the only people who may call these already have the source.
   */
  const PRIVATE_PREFIXES = ["/api/master", "/api/owner", "/api/ops", "/api/staff", "/api/billing", "/metrics"];

  await fastify.register(fastifySwagger, {
    transform: (data) => {
      const transformed = jsonSchemaTransform(data);
      if (PRIVATE_PREFIXES.some((prefix) => data.url.startsWith(prefix))) {
        return { ...transformed, schema: { ...transformed.schema, hide: true } };
      }
      return transformed;
    },
    openapi: {
      info: {
        title: "Lumina API",
        description:
          "Auto-generated from the live route table. Human sessions authenticate with `Authorization: Bearer <accessToken>` " +
          "(see POST /api/auth/login). Bots authenticate with `Authorization: Bot <token>` (see POST /api/applications) — a bot " +
          "token IS the API key; what it's allowed to do is governed by the server roles/permissions the bot has been assigned, " +
          "exactly like a human member, not a separate scope system.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", description: "Human session access token" },
          botAuth: { type: "apiKey", in: "header", name: "Authorization", description: 'Bot token, sent as "Bot <token>"' },
        },
      },
    },
  });
  await fastify.register(fastifySwaggerUi, { routePrefix: "/api/docs" });

  // Every filename in these four roots carries a fresh UUID (see lib/profileImage.ts), so a given
  // URL's bytes can never change — changing an avatar mints a new URL and the old one simply stops
  // being referenced. That makes `immutable` literally true here rather than a hopeful guess, and
  // it's what stops a member list re-fetching a hundred avatars on every navigation.
  const IMMUTABLE_ASSET = { maxAge: "365d", immutable: true } as const;
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "avatars")),
    prefix: "/avatars/",
    decorateReply: true,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "banners")),
    prefix: "/banners/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "server-icons")),
    prefix: "/server-icons/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "server-banners")),
    prefix: "/server-banners/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });

  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "emojis")),
    prefix: "/emojis/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "stickers")),
    prefix: "/stickers/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });
  // Sound files are stored as `<uuid>.<ext>` with the extension derived from the probed container
  // (see modules/soundboard/routes.ts), NOT from the uploaded filename, so fastify-static's own
  // mime lookup produces the right Content-Type. Stating one type here instead would have served
  // an Ogg or WAV clip as audio/mpeg, which browsers refuse to decode.
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "sounds")),
    prefix: "/sounds/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
    setHeaders: (res) => {
      res.setHeader("x-content-type-options", "nosniff");
    },
  });

  // Cached Minecraft skins (modules/game/minecraft.ts cacheSkin). Registered here AND in
  // nginx.conf's static regex — the custom-emoji 404 was exactly one of those two being missed.
  await fastify.register(fastifyStatic, {
    root: path.resolve(path.join(env.UPLOADS_DIR, "game-skins")),
    prefix: "/game-skins/",
    decorateReply: false,
    cacheControl: true,
    ...IMMUTABLE_ASSET,
  });

  fastify.get("/healthz", async () => ({ status: "ok" }));
  registerMetricsRoute(fastify);

  await fastify.register(authRoutes, { prefix: "/api/auth" });
  await fastify.register(usersRoutes, { prefix: "/api/users" });
  await fastify.register(opsRoutes, { prefix: "/api/ops" });
  await fastify.register(adRoutes, { prefix: "/api/ads" });
  await fastify.register(addonRoutes, { prefix: "/api/addons" });
  await fastify.register(serverAddonRoutes, { prefix: "/api/servers/:id/addons" });
  await fastify.register(serversRoutes, { prefix: "/api/servers" });
  await fastify.register(moderationRoutes, { prefix: "/api/servers" });
  await fastify.register(serverChannelsRoutes, { prefix: "/api/servers" });
  await fastify.register(channelRoutes, { prefix: "/api/channels" });
  // Prefix is /api, not /api/threads: this module owns routes under BOTH /channels/:id/threads
  // and /threads/:id, and splitting it in two would put one thread concept in two files.
  await fastify.register(threadRoutes, { prefix: "/api" });
  await fastify.register(parentalRoutes, { prefix: "/api/parental" });
  await fastify.register(discoveryRoutes, { prefix: "/api/discovery" });
  await fastify.register(gameRoutes, { prefix: "/api/game" });
  // /api prefix, not /api/activities: it owns routes under both /applications/:id/activities
  // and /activities/:id, the same split threads already use.
  await fastify.register(activityRoutes, { prefix: "/api" });
  await fastify.register(economyRoutes, { prefix: "/api/economy" });
  await fastify.register(inboxRoutes, { prefix: "/api/inbox" });
  // Same /api/servers prefix the other server-scoped modules use.
  await fastify.register(xpRoutes, { prefix: "/api/servers" });
  // Versioned economics + the gift catalogue exist from first boot — idempotent seeds.
  await seedPolicies();
  await seedGifts();
  await fastify.register(serverRolesRoutes, { prefix: "/api/servers" });
  await fastify.register(autoModServerRoutes, { prefix: "/api/servers" });
  await fastify.register(roleRoutes, { prefix: "/api/roles" });
  await fastify.register(serverInvitesRoutes, { prefix: "/api/servers" });
  await fastify.register(inviteRoutes, { prefix: "/api/invites" });
  await fastify.register(channelMessagesRoutes, { prefix: "/api/channels" });
  await fastify.register(dmMessagesRoutes, { prefix: "/api/dm" });
  await fastify.register(messageRoutes, { prefix: "/api/messages" });
  await fastify.register(dmRoutes, { prefix: "/api/dm" });
  await fastify.register(searchRoutes, { prefix: "/api/servers" });
  await fastify.register(uploadsRoutes, { prefix: "/api/files" });
  await fastify.register(channelReadRoutes, { prefix: "/api/channels" });
  await fastify.register(serverUnreadRoutes, { prefix: "/api/servers" });
  await fastify.register(notificationRoutes, { prefix: "/api/servers" });
  await fastify.register(applicationRoutes, { prefix: "/api/applications" });
  await fastify.register(channelWebhookRoutes, { prefix: "/api/channels" });
  await fastify.register(serverWebhookRoutes, { prefix: "/api/servers" });
  await fastify.register(webhookRoutes, { prefix: "/api/webhooks" });
  await fastify.register(friendRoutes, { prefix: "/api/friends" });
  await fastify.register(voiceRoutes, { prefix: "/api/voice" });
  await fastify.register(oauth2Routes, { prefix: "/api/oauth2" });
  await fastify.register(pushRoutes, { prefix: "/api/push" });
  await fastify.register(metaRoutes, { prefix: "/api/meta" });
  await fastify.register(videoRoutes, { prefix: "/api/videos" });
  await fastify.register(videoSocialRoutes, { prefix: "/api/videos" });
  await fastify.register(staffRoutes, { prefix: "/api/staff" });
  await fastify.register(reportRoutes, { prefix: "/api/staff/reports" });
  await fastify.register(feedRoutes, { prefix: "/api/feed" });
  await fastify.register(ownerRoutes, { prefix: "/api/owner" });
  await fastify.register(banRoutes, { prefix: "/api/bans" });
  await fastify.register(billingRoutes, { prefix: "/api/billing" });
  await fastify.register(storeRoutes, { prefix: "/api/store" });
  await fastify.register(emojiRoutes, { prefix: "/api/servers" });
  await fastify.register(downloadRoutes, { prefix: "/api/download" });
  await fastify.register(masterRoutes, { prefix: "/api/master" });
  await fastify.register(lookupRoutes, { prefix: "/api/lookup" });
  await fastify.register(ageRoutes, { prefix: "/api/age" });
  await fastify.register(siteRoutes, { prefix: "/api/site" });
  await fastify.register(stickerRoutes, { prefix: "/api/servers" });
  await fastify.register(soundboardRoutes, { prefix: "/api/servers" });
  await fastify.register(pollRoutes, { prefix: "/api/polls" });
  await fastify.register(interactionRoutes, { prefix: "/api/interactions" });
  await fastify.register(templateRoutes, { prefix: "/api/templates" });

  await fastify.ready();

  await initIO(fastify.server);

  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
  fastify.log.info(`Lumina backend listening on :${env.PORT}`);

  /**
   * Graceful shutdown.
   *
   * There was none. `docker compose up -d` sends SIGTERM on every deploy, Node's default action for
   * an unhandled SIGTERM is to exit immediately, and Docker then SIGKILLs after the grace period.
   * So each deploy dropped whatever was in flight: a half-written upload, a Stripe webhook mid-
   * handler (Stripe retries that one, which is the only reason it never showed), and every open
   * Socket.IO connection severed rather than closed — clients see a transport error and reconnect
   * in a thundering herd instead of a clean disconnect.
   *
   * `fastify.close()` stops accepting new connections and waits for in-flight handlers to finish,
   * and it runs any registered onClose hooks, which is what lets Prisma and the Socket.IO server
   * shut their own connections down properly.
   *
   * The timer is the safety net: if something never settles, exiting on our own terms after 15s is
   * better than waiting for SIGKILL. `unref()` so it never itself keeps the process alive.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info(`${signal} received — draining`);

    const forced = setTimeout(() => {
      fastify.log.error("shutdown timed out after 15s — exiting anyway");
      process.exit(1);
    }, 15_000);
    forced.unref();

    try {
      await fastify.close();
      fastify.log.info("closed cleanly");
      process.exit(0);
    } catch (err) {
      fastify.log.error({ err }, "error while shutting down");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
