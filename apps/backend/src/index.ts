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
import storeRoutes from "./modules/store/routes.js";
import downloadRoutes from "./modules/metrics/downloadRoutes.js";
import masterRoutes from "./modules/master/routes.js";
import lookupRoutes from "./modules/lookup/routes.js";
import ageRoutes from "./modules/age/routes.js";
import siteRoutes from "./modules/site/routes.js";

async function main() {
  await fs.mkdir(env.UPLOADS_DIR, { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "avatars"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "banners"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "server-icons"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "server-banners"), { recursive: true });
  await fs.mkdir(path.join(env.UPLOADS_DIR, "attachments"), { recursive: true });

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
  await fastify.register(fastifySwagger, {
    transform: jsonSchemaTransform,
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

  fastify.get("/healthz", async () => ({ status: "ok" }));

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
  await fastify.register(downloadRoutes, { prefix: "/api/download" });
  await fastify.register(masterRoutes, { prefix: "/api/master" });
  await fastify.register(lookupRoutes, { prefix: "/api/lookup" });
  await fastify.register(ageRoutes, { prefix: "/api/age" });
  await fastify.register(siteRoutes, { prefix: "/api/site" });

  await fastify.ready();

  await initIO(fastify.server);

  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
  fastify.log.info(`Lumina backend listening on :${env.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
