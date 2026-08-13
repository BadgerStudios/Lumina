import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { toSnowflake, fromSnowflake } from "./ids.js";
import { mapUser, mapChannel, mapGuild, mapMessage, mapRole } from "./shapes.js";

/**
 * Discord-shaped REST subset. Registered under BOTH /discord/api and /discord/api/v10 (libraries
 * append the version segment themselves).
 *
 * Reads go straight to the database; writes are TRANSLATED into internal calls against Lumina's
 * own REST API, forwarding the caller's Authorization header untouched. That keeps every
 * permission check, automod rule, rate limit, and side-effect (broadcasts, XP, inbox fanout) on
 * exactly one code path — this layer converts shapes, it never re-implements behavior.
 */

const INTERNAL = `http://127.0.0.1:${env.PORT}/api`;

async function internal(request: FastifyRequest, method: string, path: string, body?: unknown) {
  const res = await fetch(`${INTERNAL}${path}`, {
    method,
    headers: {
      authorization: request.headers.authorization ?? "",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function resolveChannel(snowflake: string) {
  const luminaId = await fromSnowflake("channel", snowflake);
  if (!luminaId) throw new NotFoundError("Unknown channel");
  const channel = await prisma.channel.findUnique({ where: { id: luminaId } });
  if (!channel) throw new NotFoundError("Unknown channel");
  return channel;
}

export default async function discordCompatRest(fastify: FastifyInstance) {
  // ---- gateway discovery (discord.js calls this before connecting)
  const gatewayUrl = `${env.PUBLIC_APP_URL.split(",")[0].trim().replace(/^http/, "ws")}/discord/gateway`;
  fastify.get("/gateway", async () => ({ url: gatewayUrl }));
  fastify.get("/gateway/bot", { preHandler: [requireAuth] }, async () => ({
    url: gatewayUrl,
    shards: 1,
    session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 },
  }));

  // ---- users
  fastify.get("/users/@me", { preHandler: [requireAuth] }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! } });
    return mapUser(user);
  });
  fastify.get("/users/:id", { preHandler: [requireAuth] }, async (request) => {
    const luminaId = await fromSnowflake("user", (request.params as { id: string }).id);
    const user = luminaId ? await prisma.user.findUnique({ where: { id: luminaId } }) : null;
    if (!user) throw new NotFoundError("Unknown user");
    return mapUser(user);
  });

  // Applications/@me — discord.js fetches this during READY handling for slash-command support.
  fastify.get("/applications/@me", { preHandler: [requireAuth] }, async (request) => {
    const app = await prisma.application.findFirst({ where: { botUser: { id: request.userId! } } });
    if (!app) throw new NotFoundError("Not a bot token");
    return { id: await toSnowflake("user", request.userId!), name: app.name, description: app.description ?? "", flags: 0, bot_public: true };
  });

  // ---- guilds
  fastify.get("/guilds/:id", { preHandler: [requireAuth] }, async (request) => {
    const luminaId = await fromSnowflake("guild", (request.params as { id: string }).id);
    if (!luminaId) throw new NotFoundError("Unknown guild");
    const server = await prisma.server.findUnique({ where: { id: luminaId } });
    if (!server) throw new NotFoundError("Unknown guild");
    const [roles, channels] = await Promise.all([
      prisma.role.findMany({ where: { serverId: luminaId } }),
      prisma.channel.findMany({ where: { serverId: luminaId, type: { not: "THREAD" } } }),
    ]);
    return mapGuild(server, roles, channels);
  });

  fastify.get("/guilds/:id/channels", { preHandler: [requireAuth] }, async (request) => {
    const luminaId = await fromSnowflake("guild", (request.params as { id: string }).id);
    if (!luminaId) throw new NotFoundError("Unknown guild");
    const channels = await prisma.channel.findMany({ where: { serverId: luminaId, type: { not: "THREAD" } } });
    return Promise.all(channels.map(mapChannel));
  });

  fastify.get("/guilds/:id/roles", { preHandler: [requireAuth] }, async (request) => {
    const snow = (request.params as { id: string }).id;
    const luminaId = await fromSnowflake("guild", snow);
    if (!luminaId) throw new NotFoundError("Unknown guild");
    const roles = await prisma.role.findMany({ where: { serverId: luminaId } });
    return Promise.all(roles.map((r) => mapRole(r, snow)));
  });

  fastify.get("/guilds/:id/members", { preHandler: [requireAuth] }, async (request) => {
    const luminaId = await fromSnowflake("guild", (request.params as { id: string }).id);
    if (!luminaId) throw new NotFoundError("Unknown guild");
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 100), 1000);
    const memberships = await prisma.membership.findMany({
      where: { serverId: luminaId },
      include: { user: true },
      take: limit,
    });
    return Promise.all(
      memberships.map(async (m) => ({
        user: await mapUser(m.user),
        nick: m.nickname ?? null,
        roles: [],
        joined_at: m.joinedAt.toISOString(),
        deaf: false,
        mute: false,
      })),
    );
  });

  // ---- channels + messages (writes translate onto the real API — one behavior code path)
  fastify.get("/channels/:id", { preHandler: [requireAuth] }, async (request) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    return mapChannel(channel);
  });

  fastify.post("/channels/:id/messages", { preHandler: [requireAuth] }, async (request, reply) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { content?: string; message_reference?: { message_id?: string } };
    if (!body.content?.trim()) throw new BadRequestError("content is required (embeds-only messages are not supported by the compat layer)");
    const res = await internal(request, "POST", `/channels/${channel.id}/messages`, {
      content: body.content,
      ...(body.message_reference?.message_id ? { replyToId: body.message_reference.message_id } : {}),
    });
    // Lumina answers 201 for creation; Discord answers 200 and libraries assert on it.
    reply.code(res.status >= 400 ? res.status : 200);
    if (res.status >= 400) return res.json;
    return mapMessage(res.json as Parameters<typeof mapMessage>[0], channel.serverId);
  });

  fastify.patch("/channels/:id/messages/:messageId", { preHandler: [requireAuth] }, async (request, reply) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const { messageId } = request.params as { messageId: string };
    const { content } = (request.body ?? {}) as { content?: string };
    const res = await internal(request, "PATCH", `/messages/${messageId}`, { content });
    reply.code(res.status);
    if (res.status >= 400) return res.json;
    return mapMessage(res.json as Parameters<typeof mapMessage>[0], channel.serverId);
  });

  fastify.delete("/channels/:id/messages/:messageId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const res = await internal(request, "DELETE", `/messages/${messageId}`);
    reply.code(res.status >= 400 ? res.status : 204).send();
  });

  fastify.put("/channels/:id/messages/:messageId/reactions/:emoji/@me", { preHandler: [requireAuth] }, async (request, reply) => {
    const { messageId, emoji } = request.params as { messageId: string; emoji: string };
    const res = await internal(request, "POST", `/messages/${messageId}/reactions`, {
      emoji: decodeURIComponent(emoji).split(":")[0],
    });
    reply.code(res.status >= 400 ? res.status : 204).send();
  });

  // ---- slash commands: discord.js registers via Routes.applicationCommands(clientId), i.e.
  // PUT /applications/:id/commands with Discord's NUMERIC option types. Translate onto Lumina's
  // bulk overwrite (authenticated as the bot itself, so :id is informational — the token names
  // the application, exactly like Lumina's own route).
  const OPTION_TYPE: Record<number, string> = { 3: "string", 4: "integer", 5: "boolean", 6: "user", 7: "channel", 10: "number" };
  fastify.put("/applications/:id/commands", async (request, reply) => {
    const commands = Array.isArray(request.body) ? (request.body as { name: string; description?: string; options?: { name: string; description?: string; type?: number; required?: boolean }[] }[]) : [];
    const mapped = commands.map((c) => ({
      name: c.name,
      description: c.description ?? "",
      options: (c.options ?? []).map((o) => ({
        name: o.name,
        description: o.description ?? "",
        type: OPTION_TYPE[o.type ?? 3] ?? "string",
        required: !!o.required,
      })),
    }));
    const res = await internal(request, "PUT", "/interactions/commands", mapped);
    reply.code(res.status >= 400 ? res.status : 200);
    if (res.status >= 400) return res.json;
    const appId = (request.params as { id: string }).id;
    return commands.map((c, i) => ({ id: String(i + 1), application_id: appId, version: "1", type: 1, ...c }));
  });
  fastify.get("/applications/:id/commands", async (request, reply) => {
    const res = await internal(request, "GET", "/interactions/commands");
    reply.code(res.status);
    return res.json;
  });

  // ---- interactions (respond via the real interaction machinery)
  fastify.post("/interactions/:id/:token/callback", async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = (request.body ?? {}) as { type?: number; data?: { content?: string } };
    // Type 4 = respond with message; type 5/6 = deferred/ack, which Lumina answers with a
    // simple acknowledgement content so the interaction doesn't visibly time out.
    const content = body.data?.content ?? (body.type === 5 || body.type === 6 ? "…" : undefined);
    if (content === undefined) throw new BadRequestError("Unsupported interaction callback type");
    const res = await internal(request, "POST", `/interactions/${token}/respond`, { content });
    reply.code(res.status >= 400 ? res.status : 204).send();
  });
}
