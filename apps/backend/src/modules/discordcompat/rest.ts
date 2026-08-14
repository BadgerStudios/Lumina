import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { toSnowflake, fromSnowflake } from "./ids.js";
import { mapUser, mapChannel, mapGuild, mapMessage, mapRole, componentsToLumina, flattenEmbeds, luminaPermsToDiscord } from "./shapes.js";
import { computeEffectivePermissions } from "../../permissions/permissionService.js";
import { attachComponents } from "../interactions/service.js";
import { serializeMessage } from "../../lib/serialize.js";
import { messageInclude, editMessage, createChannelMessage } from "../messages/service.js";

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

  fastify.get("/guilds/:id/members", { preHandler: [requireAuth] }, async (request, reply) => {
    const luminaId = await fromSnowflake("guild", (request.params as { id: string }).id);
    if (!luminaId) throw new NotFoundError("Unknown guild");
    // Privileged: listing a server's membership requires the Server Members toggle on the
    // application (Discord's GUILD_MEMBERS privileged intent, portal-enforced). Discord's own
    // error shape so libraries surface it correctly.
    const callerApp = await prisma.application.findFirst({
      where: { botUser: { id: request.userId! } },
      select: { intentServerMembers: true },
    });
    if (!callerApp?.intentServerMembers) {
      reply.code(403);
      return { message: "Missing Access: enable the Server Members intent for this application in the developer portal", code: 50001 };
    }
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

  // Single member — discord-tictactoe fetches the invoking member before starting a game.
  fastify.get("/guilds/:id/members/:userId", { preHandler: [requireAuth] }, async (request) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const guildLumina = await fromSnowflake("guild", id);
    const userLumina = await fromSnowflake("user", userId);
    if (!guildLumina || !userLumina) throw new NotFoundError("Unknown member");
    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId: userLumina, serverId: guildLumina } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundError("Unknown member");
    return {
      user: await mapUser(membership.user),
      nick: membership.nickname ?? null,
      roles: [],
      joined_at: membership.joinedAt.toISOString(),
      deaf: false,
      mute: false,
      permissions: luminaPermsToDiscord(await computeEffectivePermissions(userLumina, guildLumina).catch(() => 0n)),
    };
  });

  // Kick — translated onto Lumina's own kick route, so the bot needs the real KICK_MEMBERS
  // permission exactly like a human moderator.
  fastify.delete("/guilds/:id/members/:userId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const guildLumina = await fromSnowflake("guild", id);
    const userLumina = await fromSnowflake("user", userId);
    if (!guildLumina || !userLumina) throw new NotFoundError("Unknown member");
    const res = await internal(request, "DELETE", `/servers/${guildLumina}/members/${userLumina}`);
    reply.code(res.status >= 400 ? res.status : 204).send(res.status >= 400 ? res.json : undefined);
  });

  // ---- channels + messages (writes translate onto the real API — one behavior code path)
  fastify.get("/channels/:id", { preHandler: [requireAuth] }, async (request) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    return mapChannel(channel);
  });

  fastify.post("/channels/:id/messages", { preHandler: [requireAuth] }, async (request, reply) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { content?: string; embeds?: unknown; components?: unknown; message_reference?: { message_id?: string } };
    // Embeds flatten to text (Lumina has no bot-authored embed cards), so an embeds-only
    // message — the normal shape for giveaway/announcement bots — still says everything.
    const embedText = flattenEmbeds(body.embeds);
    const content = [body.content?.trim(), embedText].filter(Boolean).join("\n\n");
    if (!content) throw new BadRequestError("content or embeds required");
    const res = await internal(request, "POST", `/channels/${channel.id}/messages`, {
      content,
      ...(body.message_reference?.message_id ? { replyToId: body.message_reference.message_id } : {}),
    });
    // Lumina answers 201 for creation; Discord answers 200 and libraries assert on it.
    reply.code(res.status >= 400 ? res.status : 200);
    if (res.status >= 400) return res.json;
    const dto = res.json as Parameters<typeof mapMessage>[0];
    const luminaComponents = componentsToLumina(body.components);
    if (luminaComponents) {
      await attachComponents(dto.id, luminaComponents, channel.id, null);
      dto.components = luminaComponents;
    }
    return mapMessage(dto, channel.serverId);
  });

  fastify.patch("/channels/:id/messages/:messageId", { preHandler: [requireAuth] }, async (request, reply) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const { messageId } = request.params as { messageId: string };
    const body = (request.body ?? {}) as { content?: string; embeds?: unknown; components?: unknown };
    const embedText = flattenEmbeds(body.embeds);
    const content = [body.content?.trim(), embedText].filter(Boolean).join("\n\n");
    const res = await internal(request, "PATCH", `/messages/${messageId}`, { content });
    reply.code(res.status);
    if (res.status >= 400) return res.json;
    const dto = res.json as Parameters<typeof mapMessage>[0];
    const luminaComponents = componentsToLumina(body.components);
    if (luminaComponents) {
      await attachComponents(dto.id, luminaComponents, channel.id, null);
      dto.components = luminaComponents;
    }
    return mapMessage(dto, channel.serverId);
  });

  // ---- message fetches (libraries re-fetch state constantly; giveaway bots live off these)
  fastify.get("/channels/:id/messages/:messageId", { preHandler: [requireAuth] }, async (request) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const { messageId } = request.params as { messageId: string };
    const row = await prisma.message.findUnique({ where: { id: BigInt(messageId) }, include: messageInclude });
    if (!row || row.channelId !== channel.id || row.deletedAt) throw new NotFoundError("Unknown message");
    return mapMessage(serializeMessage(row, null) as Parameters<typeof mapMessage>[0], channel.serverId);
  });

  fastify.get("/channels/:id/messages", { preHandler: [requireAuth] }, async (request) => {
    const channel = await resolveChannel((request.params as { id: string }).id);
    const { limit, before } = request.query as { limit?: string; before?: string };
    const qs = new URLSearchParams();
    if (before) qs.set("before", before);
    const res = await internal(request, "GET", `/channels/${channel.id}/messages${qs.size ? `?${qs}` : ""}`);
    const list = Array.isArray(res.json) ? (res.json as Parameters<typeof mapMessage>[0][]) : [];
    const capped = list.slice(0, Math.min(Number(limit ?? 50) || 50, 100));
    return Promise.all(capped.map((m) => mapMessage(m, channel.serverId)));
  });

  // Who reacted with an emoji — the API a giveaway bot draws winners from.
  fastify.get("/channels/:id/messages/:messageId/reactions/:emoji", { preHandler: [requireAuth] }, async (request) => {
    await resolveChannel((request.params as { id: string }).id);
    const { messageId, emoji } = request.params as { messageId: string; emoji: string };
    const name = decodeURIComponent(emoji).split(":")[0];
    const rows = await prisma.reaction.findMany({
      where: { messageId: BigInt(messageId), emoji: name },
      include: { user: true },
      take: Math.min(Number((request.query as { limit?: string }).limit ?? 25) || 25, 100),
    });
    return Promise.all(rows.map((r) => mapUser(r.user)));
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

  // ---- interaction webhook routes: deferReply/editReply/fetchReply/followUp address the
  // response by application id + interaction token, UNAUTHENTICATED (Discord's design — the
  // token in the URL is the credential). The bot identity comes from the interaction's own
  // application, never from the caller's say-so.
  const interactionByToken = async (token: string) => {
    const interaction = await prisma.interaction.findUnique({ where: { token } });
    if (!interaction) throw new NotFoundError("Unknown interaction");
    const app = await prisma.application.findUnique({ where: { id: interaction.applicationId }, include: { botUser: true } });
    if (!app?.botUser) throw new NotFoundError("Unknown interaction application");
    return { interaction, botUserId: app.botUser.id };
  };

  fastify.get("/webhooks/:appId/:token/messages/@original", async (request) => {
    const { token } = request.params as { token: string };
    const { interaction } = await interactionByToken(token);
    if (!interaction.replyMessageId) throw new NotFoundError("No reply yet");
    const row = await prisma.message.findUnique({ where: { id: interaction.replyMessageId }, include: messageInclude });
    if (!row) throw new NotFoundError("Reply message gone");
    return mapMessage(serializeMessage(row, null) as Parameters<typeof mapMessage>[0], interaction.serverId);
  });

  fastify.patch("/webhooks/:appId/:token/messages/@original", async (request) => {
    const { token } = request.params as { token: string };
    const { interaction, botUserId } = await interactionByToken(token);
    if (!interaction.replyMessageId) throw new NotFoundError("No reply yet");
    const body = (request.body ?? {}) as { content?: string; embeds?: unknown; components?: unknown };
    const embedText = flattenEmbeds(body.embeds);
    const content = [body.content?.trim(), embedText].filter(Boolean).join("\n\n");
    let dto: Parameters<typeof mapMessage>[0] | null = null;
    if (content) {
      dto = (await editMessage({ userId: botUserId, messageId: interaction.replyMessageId.toString(), content })) as Parameters<typeof mapMessage>[0];
    }
    const luminaComponents = componentsToLumina(body.components);
    if (luminaComponents) {
      await attachComponents(interaction.replyMessageId.toString(), luminaComponents, interaction.channelId, interaction.dmConversationId);
    }
    if (!dto) {
      const row = await prisma.message.findUnique({ where: { id: interaction.replyMessageId }, include: messageInclude });
      if (!row) throw new NotFoundError("Reply message gone");
      dto = serializeMessage(row, null) as Parameters<typeof mapMessage>[0];
    } else if (luminaComponents) {
      dto.components = luminaComponents;
    }
    return mapMessage(dto, interaction.serverId);
  });

  fastify.post("/webhooks/:appId/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const { interaction, botUserId } = await interactionByToken(token);
    if (!interaction.channelId) throw new BadRequestError("No channel to follow up in");
    const body = (request.body ?? {}) as { content?: string; embeds?: unknown; components?: unknown };
    const embedText = flattenEmbeds(body.embeds);
    const content = [body.content?.trim(), embedText].filter(Boolean).join("\n\n");
    if (!content) throw new BadRequestError("content or embeds required");
    const dto = (await createChannelMessage({ userId: botUserId, channelId: interaction.channelId, content })) as Parameters<typeof mapMessage>[0];
    const luminaComponents = componentsToLumina(body.components);
    if (luminaComponents) {
      await attachComponents(dto.id, luminaComponents, interaction.channelId, null);
      dto.components = luminaComponents;
    }
    reply.code(200);
    return mapMessage(dto, interaction.serverId);
  });

  // ---- interactions (respond via the real interaction machinery)
  fastify.post("/interactions/:id/:token/callback", async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = (request.body ?? {}) as { type?: number; data?: { content?: string; embeds?: unknown; components?: unknown } };

    // Type 6 (DEFERRED_UPDATE_MESSAGE): a silent component acknowledgement — the bot will edit
    // (or not) at its leisure. Posting a placeholder here would spam the channel, so it only
    // marks the interaction answered. Discord answers 204; so do we.
    if (body.type === 6) {
      await prisma.interaction.updateMany({ where: { token, status: "PENDING" }, data: { status: "RESPONDED" } });
      reply.code(204).send();
      return;
    }

    // Type 7 (UPDATE_MESSAGE): interaction.update() — edit the message the component sits on
    // in place. The whole tic-tac-toe genre of bots is this callback in a loop.
    if (body.type === 7) {
      // The callback route is UNAUTHENTICATED (the token in the URL is the credential), so there
      // is no auth header to forward — the message must be edited AS THE BOT that owns the
      // interaction. Resolving the bot from the interaction and calling editMessage directly is
      // exactly what the respond path does, and keeps this off the forwarded-auth path that 401'd.
      const { interaction, botUserId } = await interactionByToken(token);
      if (!interaction.messageId || !interaction.channelId) throw new BadRequestError("No message to update");
      const embedText = flattenEmbeds(body.data?.embeds);
      const content = [body.data?.content?.trim(), embedText].filter(Boolean).join("\n\n");
      if (content) await editMessage({ userId: botUserId, messageId: interaction.messageId.toString(), content });
      const luminaComponents = componentsToLumina(body.data?.components);
      if (luminaComponents) {
        await attachComponents(interaction.messageId.toString(), luminaComponents, interaction.channelId, interaction.dmConversationId);
      }
      await prisma.interaction.updateMany({ where: { token, status: "PENDING" }, data: { status: "RESPONDED" } });
      reply.code(204).send();
      return;
    }

    // Type 4 (respond with message) and 5 (deferred response placeholder).
    const embedText = flattenEmbeds(body.data?.embeds);
    const content = [body.data?.content, embedText].filter(Boolean).join("\n\n") || (body.type === 5 ? "…" : undefined);
    if (content === undefined) throw new BadRequestError("Unsupported interaction callback type");
    const res = await internal(request, "POST", `/interactions/${token}/respond`, {
      content,
      ...(body.data?.components ? { components: componentsToLumina(body.data.components) } : {}),
    });
    reply.code(res.status >= 400 ? res.status : 204).send();
  });
}
