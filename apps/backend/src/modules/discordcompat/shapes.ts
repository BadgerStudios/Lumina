import { createHash } from "node:crypto";
import { toSnowflake } from "./ids.js";

/**
 * Lumina entities → Discord-shaped JSON. Only fields the mainstream libraries actually read;
 * every value present is truthful, and what we don't model is omitted rather than faked with
 * misleading placeholders (discord.js treats absent optional fields correctly).
 */

interface LuminaUserish {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  isBot?: boolean;
}

export async function mapUser(u: LuminaUserish) {
  return {
    id: await toSnowflake("user", u.id),
    username: u.username,
    discriminator: "0", // Discord's own post-2023 value for migrated users
    global_name: u.displayName ?? u.username,
    avatar: null, // avatars resolve via Lumina URLs, not Discord's CDN hash scheme
    bot: !!u.isBot,
  };
}

const CHANNEL_TYPE: Record<string, number> = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, THREAD: 11, STAGE: 13, FORUM: 15 };

export async function mapChannel(c: { id: string; name: string; type: string; serverId: string; topic?: string | null; parentId?: string | null; position?: number }) {
  const type = CHANNEL_TYPE[c.type] ?? 0;
  return {
    id: await toSnowflake("channel", c.id),
    guild_id: await toSnowflake("guild", c.serverId),
    name: c.name,
    type,
    topic: c.topic ?? null,
    parent_id: c.parentId ? await toSnowflake("channel", c.parentId) : null,
    position: c.position ?? 0,
    // Lumina overwrites are exposed per-request through the permissions module; the channel
    // object carries the fields libraries construct from, not the effective decision.
    permission_overwrites: [],
    nsfw: false,
    rate_limit_per_user: 0,
    last_message_id: null,
    // discord.py's VocalGuildChannel hard-indexes bitrate and user_limit (channel.py _update);
    // GUILD_CREATE with a voice channel lacking them killed Red-DiscordBot with KeyError: 'bitrate'.
    ...(isVocal(type) ? { bitrate: 64000, user_limit: 0, rtc_region: null, video_quality_mode: 1 } : {}),
  };
}

/**
 * Fields every guild-member object carries whatever built it. discord.py's Member.__init__
 * hard-indexes `flags` (member.py) — a member without it is a KeyError while parsing
 * GUILD_CREATE, i.e. the bot never sees the guild. Lumina has no member flags or onboarding
 * gate, so these are the truthful constants, spread into each of the member builders.
 */
export const MEMBER_DEFAULTS = { deaf: false, mute: false, flags: 0, pending: false } as const;

/** Discord channel types 2 (voice) and 13 (stage) — the ones libraries model as vocal. */
export function isVocal(discordType: number): boolean {
  return discordType === 2 || discordType === 13;
}

/**
 * Lumina permission bits → Discord permission bits. The NUMBERS differ even where the concepts
 * match (Lumina's SEND_MESSAGES is 1<<1, Discord's is 1<<11), and discord.js does real BigInt
 * math on these — libraries and bots gate features on channel.permissionsFor(), so passing
 * Lumina's raw field made every bot see itself as nearly permissionless (discord-tictactoe
 * refused to start a game; found live, not in review).
 *
 * Bits with no Lumina equivalent ride along with their nearest real grant — READ_MESSAGE_HISTORY
 * with view (Lumina history is visible to anyone who can view), USE_APPLICATION_COMMANDS and
 * external-emoji with send — because the TRUTH on Lumina is that those abilities come with the
 * base grant.
 */
const LUMINA_TO_DISCORD_PERM: [bigint, bigint][] = [
  [1n << 0n, (1n << 10n) | (1n << 16n)], // VIEW_CHANNELS → ViewChannel | ReadMessageHistory
  [1n << 1n, (1n << 11n) | (1n << 14n) | (1n << 18n) | (1n << 31n)], // SEND_MESSAGES → Send | EmbedLinks | UseExternalEmojis | UseApplicationCommands
  [1n << 2n, 1n << 13n], // MANAGE_MESSAGES
  [1n << 3n, 1n << 4n], // MANAGE_CHANNELS
  [1n << 4n, 1n << 28n], // MANAGE_ROLES
  [1n << 5n, 1n << 5n], // MANAGE_SERVER → ManageGuild
  [1n << 6n, 1n << 1n], // KICK_MEMBERS
  [1n << 7n, 1n << 2n], // BAN_MEMBERS
  [1n << 8n, 1n << 0n], // CREATE_INVITE
  [1n << 9n, 1n << 17n], // MENTION_EVERYONE
  [1n << 10n, 1n << 6n], // ADD_REACTIONS
  [1n << 11n, 1n << 15n], // ATTACH_FILES
  [1n << 12n, 1n << 27n], // MANAGE_NICKNAMES
  [1n << 13n, 1n << 40n], // TIMEOUT_MEMBERS → ModerateMembers
  [1n << 14n, 1n << 7n], // VIEW_AUDIT_LOG
  [1n << 15n, 1n << 3n], // ADMINISTRATOR
  [1n << 16n, 1n << 29n], // MANAGE_WEBHOOKS
  [1n << 17n, 1n << 30n], // MANAGE_EMOJI → ManageGuildExpressions
];

export function luminaPermsToDiscord(raw: bigint | string): string {
  const bits = typeof raw === "bigint" ? raw : BigInt(raw);
  let out = 0n;
  for (const [lumina, discord] of LUMINA_TO_DISCORD_PERM) if ((bits & lumina) !== 0n) out |= discord;
  return out.toString();
}

export async function mapRole(r: { id: string; name: string; color: number | null; position: number; permissions: bigint | string; serverId: string; isDefault?: boolean }, guildSnow: string) {
  return {
    id: r.isDefault ? guildSnow : await toSnowflake("role", r.id), // @everyone's id IS the guild id in Discord's model
    name: r.isDefault ? "@everyone" : r.name,
    color: r.color ?? 0,
    hoist: false,
    position: r.position,
    permissions: luminaPermsToDiscord(r.permissions),
    managed: false,
    mentionable: false,
  };
}

export async function mapGuild(
  s: { id: string; name: string; ownerId: string; description?: string | null },
  roles: Parameters<typeof mapRole>[0][],
  channels: Parameters<typeof mapChannel>[0][],
) {
  const guildSnow = await toSnowflake("guild", s.id);
  return {
    id: guildSnow,
    name: s.name,
    icon: null,
    description: s.description ?? null,
    owner_id: await toSnowflake("user", s.ownerId),
    roles: await Promise.all(roles.map((r) => mapRole(r, guildSnow))),
    channels: await Promise.all(channels.map(mapChannel)),
    members: [],
    features: [],
    emojis: [],
    stickers: [],
    voice_states: [],
    presences: [],
    threads: [],
    stage_instances: [],
    guild_scheduled_events: [],
    joined_at: new Date(0).toISOString(),
    member_count: 0,
    large: false,
    unavailable: false,
    // discord.js reads these during GuildCreate; absent would be fine, explicit is clearer.
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0,
    premium_tier: 0,
    nsfw_level: 0,
    preferred_locale: "en-US",
    afk_timeout: 300,
    afk_channel_id: null,
    system_channel_id: null,
    system_channel_flags: 0,
    rules_channel_id: null,
    vanity_url_code: null,
    banner: null,
    splash: null,
    application_id: null,
    max_members: 500000,
    premium_subscription_count: 0,
  };
}

// ---------------------------------------------------------------- components & embeds
//
// Lumina's native component tree (lib/serialize.ts parseComponents) is action-row-shaped by
// design, so Discord's rows translate nearly 1:1. Style enums and key casing differ; link
// buttons (style 5) have no Lumina equivalent and become disabled labels rather than vanishing.

const D_TO_L_STYLE: Record<number, string> = { 1: "primary", 2: "secondary", 3: "success", 4: "danger" };
const L_TO_D_STYLE: Record<string, number> = { primary: 1, secondary: 2, success: 3, danger: 4 };

export function componentsToLumina(rows: unknown): unknown[] | null {
  if (!Array.isArray(rows)) return null;
  const out: unknown[] = [];
  for (const row of rows) {
    const comps = (row as { components?: unknown[] })?.components;
    if (!Array.isArray(comps)) continue;
    const mapped = comps
      .map((c) => {
        const comp = c as { type?: number; custom_id?: string; label?: string; style?: number; disabled?: boolean; emoji?: { name?: string }; options?: { label?: string; value?: string; description?: string }[] };
        if (comp.type === 2) {
          return {
            type: "button",
            customId: comp.custom_id ?? `link:${Math.random().toString(36).slice(2, 8)}`,
            label: comp.label ?? comp.emoji?.name ?? "•",
            style: D_TO_L_STYLE[comp.style ?? 2] ?? "secondary",
            disabled: comp.disabled === true || comp.style === 5, // link buttons render inert
          };
        }
        if (comp.type === 3 && comp.custom_id && Array.isArray(comp.options)) {
          return {
            type: "select",
            customId: comp.custom_id,
            options: comp.options
              .filter((o) => typeof o?.label === "string" && typeof o?.value === "string")
              .map((o) => ({ label: o.label, value: o.value, description: o.description })),
          };
        }
        return null;
      })
      .filter(Boolean);
    if (mapped.length) out.push({ components: mapped });
  }
  return out.length ? out : null;
}

export function componentsToDiscord(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  const out: unknown[] = [];
  for (const row of rows) {
    const comps = (row as { components?: unknown[] })?.components;
    if (!Array.isArray(comps)) continue;
    const mapped = comps
      .map((c) => {
        const comp = c as { type?: string; customId?: string; label?: string; style?: string; disabled?: boolean; options?: unknown[] };
        if (comp.type === "button") {
          return { type: 2, custom_id: comp.customId, label: comp.label, style: L_TO_D_STYLE[comp.style ?? "secondary"] ?? 2, disabled: comp.disabled === true };
        }
        if (comp.type === "select") {
          return { type: 3, custom_id: comp.customId, options: comp.options ?? [] };
        }
        return null;
      })
      .filter(Boolean);
    if (mapped.length) out.push({ type: 1, components: mapped });
  }
  return out;
}

/**
 * Discord embeds → plain markdown-ish text. Lumina has no bot-authored embed cards (its embeds
 * are server-generated link previews), so the CONTENT of an embed is preserved honestly as text
 * rather than dropped — a giveaway announcement still says everything it meant to say.
 */
export function flattenEmbeds(embeds: unknown): string {
  if (!Array.isArray(embeds)) return "";
  const parts: string[] = [];
  for (const e of embeds) {
    if (!e || typeof e !== "object") continue;
    const emb = e as {
      title?: string;
      url?: string;
      description?: string;
      author?: { name?: string };
      fields?: { name?: string; value?: string }[];
      footer?: { text?: string };
      image?: { url?: string };
      thumbnail?: { url?: string };
    };
    const lines: string[] = [];
    if (emb.author?.name) lines.push(emb.author.name);
    if (emb.title) lines.push(emb.url ? `**${emb.title}** ${emb.url}` : `**${emb.title}**`);
    if (emb.description) lines.push(emb.description);
    for (const f of emb.fields ?? []) if (f?.name && f?.value) lines.push(`**${f.name}**\n${f.value}`);
    if (emb.image?.url) lines.push(emb.image.url);
    else if (emb.thumbnail?.url) lines.push(emb.thumbnail.url);
    if (emb.footer?.text) lines.push(`_${emb.footer.text}_`);
    // An embed with no words at all (a colour bar, an empty template) still IS a reply: post
    // something rather than answer the bot 400 and leave the person with a "…" forever.
    parts.push(lines.length ? lines.join("\n") : "[embed]");
  }
  return parts.join("\n\n");
}

/** MessageDTO (the shape every Lumina socket event and REST response carries) → Discord message. */
export async function mapMessage(m: {
  id: string;
  channelId: string | null;
  authorId: string | null;
  author: LuminaUserish | null;
  content: string;
  editedAt: string | null;
  pinned: boolean;
  replyToId: string | null;
  createdAt: string;
  components?: unknown;
  reactions?: { emoji: string; count: number }[];
  type?: string | null;
}, guildLuminaId?: string | null) {
  return {
    id: m.id, // native BigInt id — already numeric
    channel_id: m.channelId ? await toSnowflake("channel", m.channelId) : "0",
    guild_id: guildLuminaId ? await toSnowflake("guild", guildLuminaId) : undefined,
    author: m.author
      ? await mapUser(m.author)
      : { id: "0", username: "deleted user", discriminator: "0", global_name: "deleted user", avatar: null, bot: false },
    content: m.content,
    timestamp: m.createdAt,
    edited_timestamp: m.editedAt,
    tts: false,
    mention_everyone: m.content.includes("@everyone"),
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: componentsToDiscord(m.components),
    // Discord's reaction summaries; `me` is false because the compat layer serializes for the
    // bot's view and Lumina's DTO carries reactedByMe per-viewer, not per-bot here.
    reactions: (m.reactions ?? []).map((r) => ({ emoji: { id: null, name: r.emoji }, count: r.count, me: false })),
    pinned: m.pinned,
    // 7 = GUILD_MEMBER_JOIN: libraries render it as a system line and skip command parsing.
    type: m.type === "MEMBER_JOIN" ? 7 : m.replyToId ? 19 : 0,
    ...(m.replyToId ? { message_reference: { message_id: m.replyToId, channel_id: m.channelId ? await toSnowflake("channel", m.channelId) : "0" } } : {}),
  };
}

/**
 * discord.py (2.x, `http.json_or_text`) parses a body as JSON only when the Content-Type header is
 * *exactly* `application/json`; Fastify's default is `application/json; charset=utf-8`, which
 * discord.py hands back as a plain string and then indexes as a dict — Red-DiscordBot crashed at
 * login with "string indices must be integers". The charset is redundant for JSON (RFC 8259 §11:
 * always UTF-8), so the compat layer sends the bare type. Anything that is not JSON passes through.
 */
export function compatContentType(header: unknown): unknown {
  return typeof header === "string" && /^application\/json\b/i.test(header) ? "application/json" : header;
}

/**
 * Discord's "current application" object, with every key discord.py's AppInfo hard-indexes
 * (id, name, description, icon, bot_public, bot_require_code_grant, owner, verify_key). Red
 * derives its owner set from `owner`/`team`: no team here, so the Lumina account that created
 * the application is the bot's owner — which is exactly who ran the installer.
 * `verify_key` is Discord's Ed25519 interaction-signing key; Lumina delivers interactions over
 * the gateway rather than signed webhooks, so a stable per-application digest fills the slot.
 */
export async function mapApplication(
  app: { id: string; name: string; description: string | null; iconUrl?: string | null; owner: LuminaUserish },
  botUserId: string,
) {
  return {
    id: await toSnowflake("user", botUserId),
    name: app.name,
    description: app.description ?? "",
    icon: null,
    rpc_origins: [],
    bot_public: true,
    bot_require_code_grant: false,
    owner: await mapUser(app.owner),
    team: null,
    verify_key: createHash("sha256").update(`lumina-verify-key:${app.id}`).digest("hex"),
    flags: 0,
    summary: "",
  };
}

/**
 * The public gateway URL a bot should connect (and RE-connect) to. PUBLIC_APP_URL may list several
 * origins, comma-separated; READY's resume_gateway_url once used the raw value, so after a backend
 * restart Discord.Net (NadekoBot) rebuilt "wss://a.example,https://b.example/discord/gateway" and
 * failed every reconnect for ten minutes with "Invalid URI: The hostname could not be parsed",
 * while a fresh start (which asks /gateway, already split) worked — an asymmetry that only shows
 * on the second connection.
 */
export function gatewayUrlFor(publicAppUrl: string): string {
  const origin = publicAppUrl.split(",")[0].trim().replace(/\/+$/, "");
  return `${origin.replace(/^http/, "ws")}/discord/gateway`;
}

/**
 * Lumina error bodies are `{ error, code: "SOME_STRING" }`; Discord's are `{ code: <number>,
 * message, errors? }`, and libraries parse `code` as an integer with no fallback — JDA (Ree6)
 * died with NumberFormatException: "BAD_REQUEST" on the first 400 it met, so the bot never even
 * learned what was wrong. Codes follow Discord's published table for the statuses this layer
 * produces; 404s pick the specific "Unknown X" code from the message so a library's typed
 * handlers (e.g. discord.js's UnknownMessage) keep working.
 */
const DISCORD_CODE_BY_STATUS: Record<number, number> = { 400: 50035, 401: 40001, 403: 50013, 429: 0 };
const DISCORD_UNKNOWN_CODE: Record<string, number> = {
  application: 10002, channel: 10003, guild: 10004, member: 10007, message: 10008, role: 10011, user: 10013, webhook: 10015, interaction: 10062,
};
export function toDiscordError(status: number, body: unknown): { code: number; message: string; errors?: unknown } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof b.error === "string" ? b.error : typeof b.message === "string" ? b.message : `HTTP ${status}`;
  const unknown = status === 404 ? /unknown (application|channel|guild|member|message|role|user|webhook|interaction)/i.exec(message) : null;
  const code = unknown ? DISCORD_UNKNOWN_CODE[unknown[1].toLowerCase()] : (DISCORD_CODE_BY_STATUS[status] ?? 0);
  const errors = b.issues ?? b.details;
  return { code, message, ...(errors !== undefined ? { errors } : {}) };
}

/**
 * Discord application-command option types → Lumina's palette types. Lumina models the five
 * kinds its command palette can render; everything else arrives as a string, which every
 * library still parses on its side (JDA's getAsDouble/getAsRole read the raw value). "number"
 * (Discord 10) used to be emitted verbatim and Lumina's validator rejected the whole command
 * set — Ree6's /embed has a numeric timestamp, so none of its ~90 commands registered.
 * Subcommands (1) and groups (2) are not modelled yet and surface as a string option named
 * after the subcommand, which registers but cannot be invoked properly — a known gap.
 */
const OPTION_TYPE_TO_LUMINA: Record<number, "string" | "integer" | "boolean" | "user" | "channel"> = {
  3: "string", 4: "integer", 5: "boolean", 6: "user", 7: "channel",
};
export function optionTypeToLumina(discordType: number | undefined): "string" | "integer" | "boolean" | "user" | "channel" {
  return OPTION_TYPE_TO_LUMINA[discordType ?? 3] ?? "string";
}

/**
 * Only CHAT_INPUT commands (Discord type 1, the default) can live in Lumina's command palette.
 * USER (2) and MESSAGE (3) context-menu commands carry display names like "Report Message" that
 * fail the palette's name rule and cannot be typed anyway; they are left out of registration
 * instead of failing the bot's whole set (Ree6 ships several). The PUT still echoes them back so
 * the library sees every command it sent.
 */
export function chatInputOnly<T extends object>(commands: T[]): T[] {
  return commands.filter((c) => {
    const type = (c as { type?: number }).type;
    return type === undefined || type === 1;
  });
}

/**
 * Everything the compat onSend hook does to a reply, as a pure function: a bare JSON content-type
 * (compatContentType) and Discord-shaped error bodies (toDiscordError). The content-type is only
 * returned when there is one to set — replies without a body (204 from a DELETE or a reaction PUT)
 * have no content-type, and setting the header to undefined made Node reject the write, which
 * surfaced as a 500 "Reply was already sent" on every no-content compat route.
 */
export function compatReplyShape(statusCode: number, contentType: unknown, payload: unknown): { contentType?: string; payload: unknown } {
  const out: { contentType?: string; payload: unknown } = { payload };
  const bare = compatContentType(contentType);
  if (typeof bare === "string" && bare !== contentType) out.contentType = bare;
  if (statusCode >= 400 && typeof payload === "string" && payload.startsWith("{")) {
    try {
      out.payload = JSON.stringify(toDiscordError(statusCode, JSON.parse(payload)));
    } catch {
      /* not JSON after all — pass through */
    }
  }
  return out;
}

/**
 * Discord's rate-limit headers, on every compat reply. Lumina rate-limits on its own terms
 * inside the routes the compat layer forwards to; these headers exist because libraries' request
 * schedulers read them (JDA warns on their absence, discord.js's bucketing assumes them) and a
 * generous, honest-enough window keeps them from inventing their own throttling.
 */
export function rateLimitHeaders(routePattern: string, nowMs: number = Date.now()): Record<string, string> {
  return {
    "x-ratelimit-limit": "50",
    "x-ratelimit-remaining": "49",
    "x-ratelimit-reset": String(Math.ceil(nowMs / 1000) + 1),
    "x-ratelimit-reset-after": "1.000",
    "x-ratelimit-bucket": createHash("sha256").update(routePattern).digest("hex").slice(0, 32),
  };
}

/** A Discord application-command option as a library registers it (types are Discord's numbers). */
export interface DiscordCommandOption {
  name: string;
  description?: string;
  type?: number;
  required?: boolean;
  options?: DiscordCommandOption[];
  choices?: Array<{ name: string; value: string | number }>;
}

/**
 * Discord's nested command tree → Lumina's. Subcommands (1) and groups (2) keep their children;
 * everything else becomes a leaf option of the nearest Lumina kind.
 */
export function discordOptionsToLumina(options: DiscordCommandOption[] | undefined): unknown[] {
  return (options ?? []).map((o) =>
    o.type === 1 || o.type === 2
      ? { name: o.name, description: o.description ?? "", type: o.type === 1 ? "subcommand" : "subcommand_group", options: discordOptionsToLumina(o.options) }
      : {
          name: o.name,
          description: o.description ?? "",
          type: optionTypeToLumina(o.type),
          required: !!o.required,
          ...(Array.isArray(o.choices) ? { choices: o.choices } : {}),
        },
  );
}
export function discordCommandToLumina(c: { name: string; description?: string; options?: DiscordCommandOption[] }) {
  return { name: c.name, description: c.description ?? "", options: discordOptionsToLumina(c.options) };
}

/**
 * The `data.options` of an INTERACTION_CREATE: Lumina stores the leaf values flat plus the path
 * the user took (["welcome", "set"]); Discord nests them — group(2) → subcommand(1) → values.
 */
export function nestInteractionOptions(path: string[], options: Record<string, string | number | boolean> | null | undefined): unknown[] {
  const leaf = Object.entries(options ?? {}).map(([name, value]) => ({
    name,
    type: typeof value === "number" ? 4 : typeof value === "boolean" ? 5 : 3,
    value,
  }));
  return path.reduceRight<unknown[]>((inner, name, index) => [{ name, type: index === 0 && path.length === 2 ? 2 : 1, options: inner }], leaf);
}
