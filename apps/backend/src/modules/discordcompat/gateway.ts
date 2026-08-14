import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../../db/prisma.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { env } from "../../config/env.js";
import { toSnowflake } from "./ids.js";
import { mapUser, mapGuild, mapMessage, luminaPermsToDiscord } from "./shapes.js";
import { computeEffectiveChannelPermissions } from "../../permissions/permissionService.js";
import { serializeMessage } from "../../lib/serialize.js";
import { messageInclude } from "../messages/service.js";

/**
 * Discord-gateway-compatible websocket at /discord/gateway.
 *
 * Architecture: each gateway session opens an INTERNAL Socket.IO connection to this same
 * backend, authenticated with the bot's own token — so what a compat bot can see is decided by
 * the exact same room membership and permission logic that governs native bots, and this file
 * only ever translates shapes. No parallel event plumbing, no second permission system.
 *
 * Protocol coverage: hello(10), identify(2), heartbeat(1)/ack(11), dispatch(0) for READY,
 * GUILD_CREATE, MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE, INTERACTION_CREATE. RESUME is
 * answered with invalid-session(9, resumable=false) — the client re-identifies, which costs one
 * READY rather than a replay buffer. Unsupported asks close with a clear code, never a silent
 * hang.
 */

const HEARTBEAT_INTERVAL_MS = 41_250;

// Discord's gateway intent bits — a bot RECEIVES only what it declared, and the privileged ones
// (message content, member lists) additionally require the application's portal toggle. Same
// two-key model as Discord's own dev portal: declaration in code AND a deliberate human switch.
const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_GUILD_MESSAGE_REACTIONS = 1 << 10;
const INTENT_MESSAGE_CONTENT = 1 << 15;

interface GatewaySession {
  ws: WebSocket;
  seq: number;
  internal: ClientSocket | null;
  channelGuildCache: Map<string, string | null>;
}

function send(session: GatewaySession, op: number, d: unknown, t?: string): void {
  if (session.ws.readyState !== WebSocket.OPEN) return;
  const s = t ? ++session.seq : null;
  session.ws.send(JSON.stringify({ op, d, s, t: t ?? null }));
}

async function guildIdForChannel(session: GatewaySession, channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  if (session.channelGuildCache.has(channelId)) return session.channelGuildCache.get(channelId)!;
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
  const serverId = channel?.serverId ?? null;
  session.channelGuildCache.set(channelId, serverId);
  return serverId;
}

async function handleIdentify(session: GatewaySession, d: { token?: string; intents?: number }): Promise<void> {
  const raw = (d?.token ?? "").replace(/^Bot\s+/i, "");
  const application = await prisma.application.findFirst({
    where: { botTokenHash: hashRefreshToken(raw) },
    include: { botUser: true },
  });
  if (!application?.botUser) {
    session.ws.close(4004, "Authentication failed");
    return;
  }
  const botUser = application.botUser;
  const intents = Number(d?.intents ?? 0) || 0;
  const wantsMessages = (intents & INTENT_GUILD_MESSAGES) !== 0;
  const wantsReactions = (intents & INTENT_GUILD_MESSAGE_REACTIONS) !== 0;
  // Content needs BOTH the intent bit and the application's privileged toggle — matching
  // Discord, a bot always sees the content of its OWN messages regardless.
  const contentAllowed = (intents & INTENT_MESSAGE_CONTENT) !== 0 && application.intentMessageContent;

  // READY first with unavailable guild stubs (Discord's own sequence), then one GUILD_CREATE
  // per guild with the full object — discord.js waits for exactly this to fire its ready event.
  const memberships = await prisma.membership.findMany({ where: { userId: botUser.id }, select: { serverId: true } });
  const guildSnows = await Promise.all(memberships.map((m) => toSnowflake("guild", m.serverId)));
  send(
    session,
    0,
    {
      v: 10,
      user: { ...(await mapUser(botUser)), bot: true },
      session_id: `lumina-${Date.now().toString(36)}`,
      resume_gateway_url: `${env.PUBLIC_APP_URL.replace(/^http/, "ws")}/discord/gateway`,
      application: { id: await toSnowflake("user", botUser.id), flags: 0 },
      guilds: guildSnows.map((id) => ({ id, unavailable: true })),
      shard: [0, 1],
    },
    "READY",
  );
  for (const { serverId } of memberships) {
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) continue;
    const [roles, channels, membership] = await Promise.all([
      prisma.role.findMany({ where: { serverId } }),
      prisma.channel.findMany({ where: { serverId, type: { not: "THREAD" } } }),
      prisma.membership.findUnique({ where: { userId_serverId: { userId: botUser.id, serverId } } }),
    ]);
    const guild = await mapGuild(server, roles, channels);
    // The bot's OWN member must ride in GUILD_CREATE: discord.js's guild.members.me is how
    // libraries compute their permissions, and a null me reads as "no permissions" — the exact
    // refusal discord-tictactoe printed until this existed.
    guild.members = [
      {
        user: { ...(await mapUser(botUser)), bot: true },
        nick: membership?.nickname ?? null,
        roles: [],
        joined_at: (membership?.joinedAt ?? new Date(0)).toISOString(),
        deaf: false,
        mute: false,
      },
    ] as never;
    guild.member_count = await prisma.membership.count({ where: { serverId } });
    send(session, 0, guild, "GUILD_CREATE");
  }

  // The translation feed: a native bot socket, speaking Lumina events in, Discord dispatches out.
  const internal = ioClient(`http://127.0.0.1:${env.PORT}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { botToken: raw },
  });
  session.internal = internal;

  // Message broadcasts go to channel:<id> rooms, which native clients join per-channel as they
  // view them. A Discord bot's contract is "every message in every guild I'm in", so the
  // translator joins every channel room up front (server rooms were auto-joined at connect).
  internal.on("connect", () => {
    if (!wantsMessages) return; // no GUILD_MESSAGES intent — the bot asked to hear no messages
    void (async () => {
      const channels = await prisma.channel.findMany({
        where: { serverId: { in: memberships.map((m) => m.serverId) }, type: { in: ["TEXT", "THREAD"] } },
        select: { id: true },
      });
      for (const c of channels) internal.emit("channel:join", { channelId: c.id });
    })().catch(() => undefined);
  });

  const dispatchMessage = (t: string) => (m: Parameters<typeof mapMessage>[0]) => {
    if (!wantsMessages) return;
    void (async () => {
      // The bot's own REST sends echo back through the room; Discord's gateway also does this,
      // so they are forwarded rather than filtered — libraries expect their own messages.
      const mapped = await mapMessage(m, await guildIdForChannel(session, m.channelId));
      if (!contentAllowed && m.authorId !== botUser.id) {
        // Discord's exact privileged-content behavior: the event still flows, the content is
        // blank. Bots that need it declare the intent AND their owner flips the portal toggle.
        mapped.content = "";
      }
      send(session, 0, mapped, t);
    })().catch(() => undefined);
  };
  internal.on("message:create", dispatchMessage("MESSAGE_CREATE"));
  internal.on("message:update", dispatchMessage("MESSAGE_UPDATE"));
  internal.on("message:delete", (payload: { id: string; channelId?: string | null }) => {
    void (async () => {
      const guildLumina = await guildIdForChannel(session, payload.channelId ?? null);
      send(
        session,
        0,
        {
          id: payload.id,
          channel_id: payload.channelId ? await toSnowflake("channel", payload.channelId) : "0",
          ...(guildLumina ? { guild_id: await toSnowflake("guild", guildLumina) } : {}),
        },
        "MESSAGE_DELETE",
      );
    })().catch(() => undefined);
  });
  // Reactions: Lumina broadcasts {messageId, emoji, userId, count} to the channel room; Discord
  // dispatches carry channel/guild ids, so the message's location is looked up (and cached — a
  // reaction pile-on is many events on one message).
  const messageLocation = new Map<string, { channelId: string; serverId: string | null } | null>();
  const locate = async (messageId: string) => {
    if (messageLocation.has(messageId)) return messageLocation.get(messageId);
    const row = await prisma.message.findUnique({ where: { id: BigInt(messageId) }, select: { channelId: true, channel: { select: { serverId: true } } } });
    const loc = row?.channelId ? { channelId: row.channelId, serverId: row.channel?.serverId ?? null } : null;
    messageLocation.set(messageId, loc);
    return loc;
  };
  const reactionDispatch = (t: string) => (payload: { messageId: string; emoji: string; userId: string }) => {
    void (async () => {
      const loc = await locate(payload.messageId);
      if (!loc) return;
      send(session, 0, {
        user_id: await toSnowflake("user", payload.userId),
        message_id: payload.messageId,
        channel_id: await toSnowflake("channel", loc.channelId),
        ...(loc.serverId ? { guild_id: await toSnowflake("guild", loc.serverId) } : {}),
        emoji: { id: null, name: payload.emoji },
      }, t);
    })().catch(() => undefined);
  };
  if (wantsReactions) {
    internal.on("reaction:add", reactionDispatch("MESSAGE_REACTION_ADD"));
    internal.on("reaction:remove", reactionDispatch("MESSAGE_REACTION_REMOVE"));
  }

  internal.on(
    "interaction:create",
    (i: { id: string; token: string; type: string; commandName: string | null; options: Record<string, string | number | boolean> | null; customId: string | null; channelId: string | null; serverId: string | null; userId: string; messageId: string | null }) => {
      void (async () => {
        const user = await prisma.user.findUnique({ where: { id: i.userId } });
        if (!user) return;
        const mappedUser = await mapUser(user);
        const isCommand = i.type === "command" || !!i.commandName;
        // app_permissions is what libraries treat as "what am I allowed to do here" — computed
        // from Lumina's REAL permission engine (roles + channel overwrites) and translated to
        // Discord bit positions. Hardcoding "0" made permission-checking bots refuse to work.
        const botEff = i.serverId && i.channelId
          ? await computeEffectiveChannelPermissions(botUser.id, i.serverId, i.channelId).catch(() => 0n)
          : 0n;
        const invokerEff = i.serverId && i.channelId
          ? await computeEffectiveChannelPermissions(i.userId, i.serverId, i.channelId).catch(() => 0n)
          : 0n;
        send(
          session,
          0,
          {
            id: i.id.match(/^\d+$/) ? i.id : await toSnowflake("role", `interaction:${i.id}`),
            token: i.token,
            version: 1,
            type: isCommand ? 2 : 3,
            application_id: (await mapUser(botUser)).id,
            channel_id: i.channelId ? await toSnowflake("channel", i.channelId) : undefined,
            ...(i.serverId
              ? {
                  guild_id: await toSnowflake("guild", i.serverId),
                  member: { user: mappedUser, roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false, permissions: luminaPermsToDiscord(invokerEff) },
                }
              : { user: mappedUser }),
            // Component interactions carry the message they sit on — discord.js's
            // interaction.update()/message accessors dereference it.
            ...(!isCommand && i.messageId
              ? {
                  message: await (async () => {
                    const row = await prisma.message.findUnique({ where: { id: BigInt(i.messageId!) }, include: messageInclude });
                    return row ? await mapMessage(serializeMessage(row, null), i.serverId) : undefined;
                  })(),
                }
              : {}),
            data: isCommand
              ? {
                  id: await toSnowflake("role", `command:${i.commandName}`),
                  name: i.commandName,
                  type: 1,
                  // Lumina stores options as a {name: value} record; Discord's shape is an
                  // array of {name, type, value} — translate so getString()/getInteger() work.
                  options:
                    i.options && typeof i.options === "object"
                      ? Object.entries(i.options).map(([name, value]) => ({
                          name,
                          type: typeof value === "number" ? 4 : typeof value === "boolean" ? 5 : 3,
                          value,
                        }))
                      : [],
                }
              : { custom_id: i.customId, component_type: 2 },
            app_permissions: luminaPermsToDiscord(botEff),
            locale: "en-US",
            guild_locale: "en-US",
            // discord.js ≥14.2x dereferences these unconditionally (monetization + user-app
            // installs); omitting them crashes its INTERACTION_CREATE handler outright.
            entitlements: [],
            authorizing_integration_owners: {},
            context: 0,
            ...(i.channelId ? { channel: { id: await toSnowflake("channel", i.channelId), type: 0 } } : {}),
          },
          "INTERACTION_CREATE",
        );
      })().catch(() => undefined);
    },
  );
}

export function attachDiscordGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (!url.startsWith("/discord/gateway")) return; // socket.io's own upgrade handler owns the rest
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    const session: GatewaySession = { ws, seq: 0, internal: null, channelGuildCache: new Map() };
    send(session, 10, { heartbeat_interval: HEARTBEAT_INTERVAL_MS });

    // A client that never heartbeats is a dead client; Discord zombie-detects the same way.
    let lastBeat = Date.now();
    const reaper = setInterval(() => {
      if (Date.now() - lastBeat > HEARTBEAT_INTERVAL_MS * 2.5) ws.close(4009, "Session timed out");
    }, HEARTBEAT_INTERVAL_MS);

    ws.on("message", (raw) => {
      let packet: { op?: number; d?: unknown };
      try {
        packet = JSON.parse(String(raw));
      } catch {
        ws.close(4002, "Decode error");
        return;
      }
      switch (packet.op) {
        case 1: // heartbeat
          lastBeat = Date.now();
          send(session, 11, null);
          break;
        case 2: // identify
          void handleIdentify(session, (packet.d ?? {}) as { token?: string });
          break;
        case 6: // resume — we keep no replay buffer; a fresh identify costs one READY
          send(session, 9, false);
          break;
        case 3: // presence update — accepted and ignored (Lumina presence is account-level)
          break;
        case 8: // request guild members — answer an empty final chunk so fetches resolve
          send(session, 0, { guild_id: (packet.d as { guild_id?: string })?.guild_id ?? "0", members: [], chunk_index: 0, chunk_count: 1 }, "GUILD_MEMBERS_CHUNK");
          break;
        default:
          break; // unknown ops are ignored, matching Discord's own tolerance
      }
    });

    ws.on("close", () => {
      clearInterval(reaper);
      session.internal?.close();
    });
  });
}
