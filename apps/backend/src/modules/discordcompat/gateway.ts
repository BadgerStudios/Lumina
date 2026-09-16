import { discordVoiceServer, type VoiceSession, type VoiceStateRequest } from "./voice/server.js";
import { memberRoleSnowflakes, threadOwnerId } from "./members.js";
import { createDeflate, createZstdCompress, constants as zlibConstants, type Deflate, type ZstdCompress } from "node:zlib";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { prisma } from "../../db/prisma.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { env } from "../../config/env.js";
import { toSnowflake, timeSnowflake, fromSnowflake } from "./ids.js";
import { mapUser, mapGuild, mapMessage, luminaPermsToDiscord, MEMBER_DEFAULTS, gatewayUrlFor, mapRole, mapChannel, nestInteractionOptions, mapThread, type ThreadLike } from "./shapes.js";
import { computeEffectiveChannelPermissions } from "../../permissions/permissionService.js";
import { serializeMessage } from "../../lib/serialize.js";
import { messageInclude } from "../messages/service.js";
import { parseBigIntId } from "../../lib/parseBigIntId.js";
import { getIO } from "../../realtime/io.js";

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
  /** GUILD_MEMBERS intent declared AND the portal toggle on: the full member list may be chunked. */
  membersAllowed: boolean;
  /**
   * Set when the client asked for compress=zlib-stream or zstd-stream: one shared compression
   * context for the whole session, plus the flush flag that closes each payload.
   */
  deflate: { stream: Deflate | ZstdCompress; flush: number } | null;
  /** Compressed sends are async; this keeps them in order. */
  sendChain: Promise<void>;
  /** Known after IDENTIFY: which bot this session is. */
  botUserId: string | null;
  /** The bot's seat in a voice channel, while it has one (voice/server.ts). */
  voice: VoiceSession | null;
  /** Who this session last told the bot is in each voice channel, so roster broadcasts become deltas. */
  voiceRosters: Map<string, Set<string>>;
}

function send(session: GatewaySession, op: number, d: unknown, t?: string): void {
  if (session.ws.readyState !== WebSocket.OPEN) return;
  const s = t ? ++session.seq : null;
  const json = JSON.stringify({ op, d, s, t: t ?? null });
  const compressor = session.deflate;
  if (!compressor) {
    session.ws.send(json);
    return;
  }
  const { stream: deflate, flush } = compressor;
  // zlib-stream, exactly as Discord does it: one deflate context for the whole session, each
  // payload terminated by a Z_SYNC_FLUSH so the client can cut the stream at 00 00 FF FF. Every
  // payload goes out as ONE binary frame — Discord.Net decompresses a frame and parses it as one
  // JSON document, so splitting a payload across frames would lose it. Paused-mode read() after
  // the flush hands back everything the flush produced, in order, without racing 'data' events.
  session.sendChain = session.sendChain
    .then(
      () =>
        new Promise<void>((resolve) => {
          deflate.write(json);
          deflate.flush(flush, () => {
            const out = deflate.read() as Buffer | null;
            if (out && session.ws.readyState === WebSocket.OPEN) session.ws.send(out, { binary: true });
            resolve();
          });
        }),
    )
    .catch(() => undefined);
}

async function guildIdForChannel(session: GatewaySession, channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  if (session.channelGuildCache.has(channelId)) return session.channelGuildCache.get(channelId)!;
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
  const serverId = channel?.serverId ?? null;
  session.channelGuildCache.set(channelId, serverId);
  return serverId;
}

/** One guild, in full, as GUILD_CREATE — at identify for every membership, and again live when the bot is added to a space. */
/** A person's voice state in Discord's shape; `member` rides along so a library that has not chunked the guild can still place them. */
async function humanVoiceState(guildSnow: string, serverId: string, channelSnow: string | null, userId: string) {
  const membership = await prisma.membership.findUnique({ where: { userId_serverId: { userId, serverId } }, include: { user: true } });
  return {
    guild_id: guildSnow,
    channel_id: channelSnow,
    user_id: await toSnowflake("user", userId),
    session_id: `lumina-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
    ...(membership
      ? {
          member: {
            user: await mapUser(membership.user),
            nick: membership.nickname ?? null,
            roles: await memberRoleSnowflakes(userId, serverId),
            joined_at: membership.joinedAt.toISOString(),
            ...MEMBER_DEFAULTS,
          },
        }
      : {}),
  };
}

/**
 * Everyone currently in the guild's voice channels, from the live `voice:<channel>` rooms — the
 * `voice_states` of GUILD_CREATE. A music bot's "join the channel you are in" needs this; before it
 * existed a bot only ever heard about a channel it had itself joined. Seeds the session's rosters.
 */
async function voiceStatesFor(session: GatewaySession, serverId: string, guildSnow: string, channels: Array<{ id: string; type: string }>, skipUserId: string) {
  const states: unknown[] = [];
  const io = getIO();
  for (const c of channels) {
    if (c.type !== "VOICE" && c.type !== "STAGE") continue;
    const users = new Set<string>();
    try {
      for (const s of await io.in(`voice:${c.id}`).fetchSockets()) {
        if (typeof s.data.userId === "string") users.add(s.data.userId);
      }
    } catch {
      continue;
    }
    session.voiceRosters.set(c.id, users);
    const channelSnow = await toSnowflake("channel", c.id);
    for (const u of users) {
      if (u !== skipUserId) states.push(await humanVoiceState(guildSnow, serverId, channelSnow, u));
    }
  }
  return states;
}

async function dispatchGuildCreate(session: GatewaySession, botUser: Parameters<typeof mapUser>[0], serverId: string, live = false): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return;
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
      // The bot's real roles: libraries resolve its permissions (and every BotPerm check) from them.
      roles: await memberRoleSnowflakes(botUser.id, serverId),
      joined_at: (membership?.joinedAt ?? new Date(0)).toISOString(),
      ...MEMBER_DEFAULTS,
    },
  ] as never;
  guild.member_count = await prisma.membership.count({ where: { serverId } });
  (guild as { voice_states?: unknown[] }).voice_states = await voiceStatesFor(session, serverId, guild.id as string, channels, botUser.id);
  // Active threads ride in GUILD_CREATE (discord.js keeps them in guild.channels from here).
  const activeThreads = await prisma.channel.findMany({
    where: { serverId, type: "THREAD", archived: false },
    include: { _count: { select: { messages: true, threadMembers: true } } },
    take: 100,
  });
  (guild as { threads?: unknown[] }).threads = await Promise.all(
    activeThreads.map(async (r) =>
      mapThread(
        {
          id: r.id, serverId: r.serverId, name: r.name, parentId: r.parentId, archived: r.archived,
          archivedAt: r.archivedAt?.toISOString() ?? null, autoArchiveMinutes: r.autoArchiveMinutes,
          createdAt: r.createdAt.toISOString(), messageCount: r._count.messages, memberCount: r._count.threadMembers,
        },
        await threadOwnerId(r.id),
      ),
    ),
  );
  // Discord.Net reads `unavailable: false` as "a guild from READY became available" and, finding
  // no such guild, logs Unknown Guild and drops it (NadekoBot, added live to a space). A real
  // join carries no `unavailable` key at all — that absence is what selects the join path.
  if (live) delete (guild as { unavailable?: boolean }).unavailable;
  send(session, 0, guild, "GUILD_CREATE");
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
  session.membersAllowed = (intents & INTENT_GUILD_MEMBERS) !== 0 && application.intentServerMembers;

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
      resume_gateway_url: gatewayUrlFor(env.PUBLIC_APP_URL),
      application: { id: await toSnowflake("user", botUser.id), flags: 0 },
      guilds: guildSnows.map((id) => ({ id, unavailable: true })),
      // Always present on Discord's READY, empty for a bot. Discord.Net (NadekoBot) walks it
      // without a null check and died on "Processing READY failed" when it was absent — the
      // first thing a real .NET bot did against this gateway.
      private_channels: [],
      shard: [0, 1],
    },
    "READY",
  );
  for (const { serverId } of memberships) await dispatchGuildCreate(session, botUser, serverId);

  // The translation feed: a native bot socket, speaking Lumina events in, Discord dispatches out.
  const internal = ioClient(`http://127.0.0.1:${env.PORT}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { botToken: raw },
  });
  session.internal = internal;
  session.botUserId = botUser.id;

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

  // Added to a space while connected (Bots panel → "Add to this space"): the guild arrives the
  // way a real join does — GUILD_CREATE, then its channel rooms — so the bot answers there at once.
  internal.on("server:joined", (payload: { serverId?: string }) => {
    const serverId = payload?.serverId;
    if (!serverId) return;
    void (async () => {
      await dispatchGuildCreate(session, botUser, serverId, true);
      if (!wantsMessages) return;
      const channels = await prisma.channel.findMany({ where: { serverId, type: { in: ["TEXT", "THREAD"] } }, select: { id: true } });
      for (const c of channels) internal.emit("channel:join", { channelId: c.id });
    })().catch(() => undefined);
  });

  // Pin set changed (reaches bots that joined the channel's room, i.e. those with GUILD_MESSAGES).
  internal.on("channel:pins-update", (payload: { channelId?: string; lastPinAt?: string | null }) => {
    const channelId = payload?.channelId;
    if (!channelId) return;
    void (async () => {
      const guildLumina = await guildIdForChannel(session, channelId);
      send(
        session,
        0,
        {
          ...(guildLumina ? { guild_id: await toSnowflake("guild", guildLumina) } : {}),
          channel_id: await toSnowflake("channel", channelId),
          last_pin_timestamp: payload.lastPinAt ?? null,
        },
        "CHANNEL_PINS_UPDATE",
      );
    })().catch(() => undefined);
  });

  // Who is in which voice channel. Lumina broadcasts the full roster of a channel to the whole space
  // on every join/leave; the bot gets the difference as VOICE_STATE_UPDATEs — how a music bot knows
  // which channel the person who typed "play" is sitting in. The channel the bot itself is in is
  // narrated by its voice session (voice/server.ts), so it is skipped here to avoid doubles.
  internal.on("voice:roster-update", (payload: { channelId?: string; participants?: Array<{ userId?: string }> }) => {
    const channelId = payload?.channelId;
    if (!channelId || channelId.startsWith("dm:")) return;
    void (async () => {
      const now = new Set<string>();
      for (const p of payload.participants ?? []) if (typeof p?.userId === "string") now.add(p.userId);
      const before = session.voiceRosters.get(channelId) ?? new Set<string>();
      session.voiceRosters.set(channelId, now);
      if (session.voice && session.voice.channelId === channelId) return;
      const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { serverId: true } });
      if (!channel) return;
      const guildSnow = await toSnowflake("guild", channel.serverId);
      const channelSnow = await toSnowflake("channel", channelId);
      for (const u of now) {
        if (!before.has(u) && u !== botUser.id) send(session, 0, await humanVoiceState(guildSnow, channel.serverId, channelSnow, u), "VOICE_STATE_UPDATE");
      }
      for (const u of before) {
        if (!now.has(u) && u !== botUser.id) send(session, 0, await humanVoiceState(guildSnow, channel.serverId, null, u), "VOICE_STATE_UPDATE");
      }
    })().catch(() => undefined);
  });

  // ---- guild lifecycle: what Lumina broadcasts to the space, in Discord's dispatch shapes.
  // Welcome/autorole bots live on GUILD_MEMBER_ADD; moderation bots on the ban events; every
  // library keeps its role/channel caches in step from the rest.
  const guildSnowOf = (serverId: string) => toSnowflake("guild", serverId);
  type MemberLike = { userId: string; serverId: string; nickname: string | null; joinedAt: string; user: Parameters<typeof mapUser>[0]; roleIds: string[] };
  const memberPayload = async (m: MemberLike) => ({
    guild_id: await guildSnowOf(m.serverId),
    user: await mapUser(m.user),
    nick: m.nickname,
    roles: await Promise.all(m.roleIds.map((r) => toSnowflake("role", r))),
    joined_at: m.joinedAt,
    ...MEMBER_DEFAULTS,
  });
  const userPayload = async (p: { userId: string; serverId: string }) => {
    const user = await prisma.user.findUnique({ where: { id: p.userId } });
    return user ? { guild_id: await guildSnowOf(p.serverId), user: await mapUser(user) } : null;
  };
  const on = <T,>(event: string, handler: (payload: T) => Promise<void>) =>
    internal.on(event, (payload: T) => void handler(payload).catch(() => undefined));
  on<MemberLike>("member:join", async (m) => send(session, 0, await memberPayload(m), "GUILD_MEMBER_ADD"));
  on<MemberLike>("member:update", async (m) => send(session, 0, await memberPayload(m), "GUILD_MEMBER_UPDATE"));
  on<{ userId: string; serverId: string }>("member:leave", async (p) => {
    const payload = await userPayload(p);
    if (payload) send(session, 0, payload, "GUILD_MEMBER_REMOVE");
  });
  on<{ userId: string; serverId: string }>("ban:add", async (p) => {
    const payload = await userPayload(p);
    if (payload) send(session, 0, payload, "GUILD_BAN_ADD");
  });
  on<{ userId: string; serverId: string }>("ban:remove", async (p) => {
    const payload = await userPayload(p);
    if (payload) send(session, 0, payload, "GUILD_BAN_REMOVE");
  });
  type RoleLike = Parameters<typeof mapRole>[0];
  on<RoleLike>("role:create", async (r) => send(session, 0, { guild_id: await guildSnowOf(r.serverId), role: await mapRole(r, await guildSnowOf(r.serverId)) }, "GUILD_ROLE_CREATE"));
  on<RoleLike>("role:update", async (r) => send(session, 0, { guild_id: await guildSnowOf(r.serverId), role: await mapRole(r, await guildSnowOf(r.serverId)) }, "GUILD_ROLE_UPDATE"));
  on<{ id: string; serverId: string }>("role:delete", async (p) => send(session, 0, { guild_id: await guildSnowOf(p.serverId), role_id: await toSnowflake("role", p.id) }, "GUILD_ROLE_DELETE"));
  type ChannelLike = Parameters<typeof mapChannel>[0];
  on<ChannelLike>("channel:create", async (c) => {
    send(session, 0, await mapChannel(c), "CHANNEL_CREATE");
    // A new text room is part of "every message in every guild I'm in".
    if (wantsMessages && (c.type === "TEXT" || c.type === "THREAD")) internal.emit("channel:join", { channelId: c.id });
  });
  on<ChannelLike>("channel:update", async (c) => send(session, 0, await mapChannel(c), "CHANNEL_UPDATE"));
  on<ThreadLike>("thread:create", async (t) => {
    send(session, 0, await mapThread(t, await threadOwnerId(t.id), true), "THREAD_CREATE");
    // A new thread is a new room of "every message in every guild I'm in".
    if (wantsMessages) internal.emit("channel:join", { channelId: t.id });
  });
  on<ThreadLike>("thread:update", async (t) => send(session, 0, await mapThread(t, await threadOwnerId(t.id)), "THREAD_UPDATE"));
  on<{ id: string; serverId: string }>("channel:delete", async (p) => send(session, 0, { id: await toSnowflake("channel", p.id), guild_id: await guildSnowOf(p.serverId), type: 0 }, "CHANNEL_DELETE"));
  on<{ channelId: string; userId: string; isTyping: boolean }>("typing:update", async (p) => {
    if (!p.isTyping || !wantsMessages) return;
    const guildLumina = await guildIdForChannel(session, p.channelId);
    send(
      session,
      0,
      {
        channel_id: await toSnowflake("channel", p.channelId),
        ...(guildLumina ? { guild_id: await toSnowflake("guild", guildLumina) } : {}),
        user_id: await toSnowflake("user", p.userId),
        timestamp: Math.floor(Date.now() / 1000),
      },
      "TYPING_START",
    );
  });
  on<{ id: string }>("server:update", async (p) => {
    const [server, roles, channels] = await Promise.all([
      prisma.server.findUnique({ where: { id: p.id } }),
      prisma.role.findMany({ where: { serverId: p.id } }),
      prisma.channel.findMany({ where: { serverId: p.id, type: { not: "THREAD" } } }),
    ]);
    if (server) send(session, 0, await mapGuild(server, roles, channels), "GUILD_UPDATE");
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
      // Every emitter sends the channel now; an older one that does not is resolved from the row
      // (soft-deleted, so it is still there) rather than dispatched as channel "0".
      let channelId = payload.channelId ?? null;
      if (!channelId) {
        const mid = parseBigIntId(payload.id);
        const row = mid === null ? null : await prisma.message.findUnique({ where: { id: mid }, select: { channelId: true } });
        channelId = row?.channelId ?? null;
      }
      if (!channelId) return; // a DM deletion: bots are not in DMs through this feed
      const guildLumina = await guildIdForChannel(session, channelId);
      send(
        session,
        0,
        {
          id: payload.id,
          channel_id: await toSnowflake("channel", channelId),
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
    const mid = parseBigIntId(messageId);
    if (mid === null) { messageLocation.set(messageId, null); return null; }
    const row = await prisma.message.findUnique({ where: { id: mid }, select: { channelId: true, channel: { select: { serverId: true } } } });
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
    (i: { id: string; token: string; type: string; commandName: string | null; commandPath?: string[]; options: Record<string, string | number | boolean> | null; customId: string | null; channelId: string | null; serverId: string | null; userId: string; messageId: string | null }) => {
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
            id: timeSnowflake(), // creation time is read off this id (see ids.ts); the token, not the id, routes the reply
            token: i.token,
            version: 1,
            type: isCommand ? 2 : 3,
            application_id: (await mapUser(botUser)).id,
            channel_id: i.channelId ? await toSnowflake("channel", i.channelId) : undefined,
            ...(i.serverId
              ? {
                  guild_id: await toSnowflake("guild", i.serverId),
                  // JDA 6 resolves the guild from THIS partial object (InteractionImpl:
                  // data.optObject("guild")), never from guild_id; without it every guild
                  // interaction read as a DM and Ree6 threw "unexpected channel type TEXT".
                  guild: { id: await toSnowflake("guild", i.serverId), locale: "en-US", features: [] },
                  member: { user: mappedUser, roles: await memberRoleSnowflakes(i.userId, i.serverId), joined_at: new Date(0).toISOString(), ...MEMBER_DEFAULTS, permissions: luminaPermsToDiscord(invokerEff) },
                }
              : { user: mappedUser }),
            // Component interactions carry the message they sit on — discord.js's
            // interaction.update()/message accessors dereference it.
            ...(!isCommand && i.messageId
              ? {
                  message: await (async () => {
                    const mid = parseBigIntId(i.messageId);
                    if (mid === null) return undefined;
                    const row = await prisma.message.findUnique({ where: { id: mid }, include: messageInclude });
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
                  options: nestInteractionOptions(i.commandPath ?? [], i.options),
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

interface RequestMembers {
  guild_id?: string;
  query?: string;
  limit?: number;
  nonce?: string;
  user_ids?: string | string[];
}

/**
 * GUILD_MEMBERS_CHUNK. Discord's rule, kept: the whole list needs the members intent (declared in
 * IDENTIFY and switched on in the portal); a username prefix query or an explicit id list is
 * answered regardless. The nonce comes back so libraries that match requests to chunks (discord.py,
 * JDA) resolve instead of waiting sixty seconds for a reply that never arrives.
 */
async function handleRequestMembers(session: GatewaySession, d: RequestMembers): Promise<void> {
  const guildSnow = d.guild_id ?? "0";
  const chunk = (members: unknown[]) =>
    send(session, 0, { guild_id: guildSnow, members, chunk_index: 0, chunk_count: 1, ...(d.nonce ? { nonce: d.nonce } : {}) }, "GUILD_MEMBERS_CHUNK");
  const serverId = await fromSnowflake("guild", guildSnow);
  const query = (d.query ?? "").trim().toLowerCase();
  const explicitIds = d.user_ids ? (Array.isArray(d.user_ids) ? d.user_ids : [d.user_ids]).map(String) : null;
  if (!serverId || (!session.membersAllowed && !query && !explicitIds)) {
    chunk([]);
    return;
  }
  const wanted = explicitIds ? new Set(await Promise.all(explicitIds.map((id) => fromSnowflake("user", id)))) : null;
  const rows = await prisma.membership.findMany({
    where: { serverId, ...(query ? { user: { username: { startsWith: query, mode: "insensitive" } } } : {}) },
    include: { user: true, roles: { select: { roleId: true } } },
    take: Math.min(Math.max(Number(d.limit) || 1000, 1), 1000),
    orderBy: { joinedAt: "asc" },
  });
  const members: unknown[] = [];
  for (const m of rows) {
    if (wanted && !wanted.has(m.userId)) continue;
    members.push({
      user: { ...(await mapUser(m.user)), bot: !!m.user.isBot },
      nick: m.nickname,
      roles: await Promise.all(m.roles.map((r) => toSnowflake("role", r.roleId))),
      joined_at: m.joinedAt.toISOString(),
      ...MEMBER_DEFAULTS,
    });
  }
  chunk(members);
}

export function attachDiscordGateway(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (discordVoiceServer.handleUpgrade(request, socket, head)) return; // /discord/voice
    if (!url.startsWith("/discord/gateway")) return; // socket.io's own upgrade handler owns the rest
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws, request: { url?: string }) => {
    // Compression is negotiated in the URL, Discord's way. discord.py 2.7 asks for zstd-stream
    // and decompresses each frame as one complete payload; Discord.Net and JDA ask for
    // zlib-stream. Anything else gets plain JSON text frames.
    const url = request?.url ?? "";
    const compress = /[?&]compress=zstd-stream(?:&|$)/.test(url)
      ? { stream: createZstdCompress(), flush: zlibConstants.ZSTD_e_flush }
      : /[?&]compress=zlib-stream(?:&|$)/.test(url)
        ? { stream: createDeflate(), flush: zlibConstants.Z_SYNC_FLUSH }
        : null;
    const session: GatewaySession = {
      ws,
      seq: 0,
      internal: null,
      channelGuildCache: new Map(),
      membersAllowed: false,
      deflate: compress,
      sendChain: Promise.resolve(),
      botUserId: null,
      voice: null,
      voiceRosters: new Map(),
    };
    session.deflate?.stream.on("error", () => ws.close(4000, "Compression failed"));
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
        case 4: // voice state update — the bot joins, moves or leaves a voice channel
          if (session.botUserId && session.internal) {
            void discordVoiceServer
              .onVoiceStateUpdate({
                botUserId: session.botUserId,
                internal: session.internal,
                request: (packet.d ?? {}) as VoiceStateRequest,
                dispatch: (t, d) => send(session, 0, d, t),
                current: session.voice,
              })
              .then((voice) => {
                session.voice = voice;
              })
              .catch((err) => console.error("[discord-voice] voice state update failed:", (err as Error)?.message ?? err));
          }
          break;
        case 3: // presence update — accepted and ignored (Lumina presence is account-level)
          break;
        case 8: // request guild members — real members, nonce echoed, intent-gated like Discord
          void handleRequestMembers(session, (packet.d ?? {}) as RequestMembers);
          break;
        default:
          break; // unknown ops are ignored, matching Discord's own tolerance
      }
    });

    ws.on("close", () => {
      clearInterval(reaper);
      discordVoiceServer.endForGateway(session.voice);
      session.voice = null;
      session.internal?.close();
      session.deflate?.stream.close();
    });
  });
}
