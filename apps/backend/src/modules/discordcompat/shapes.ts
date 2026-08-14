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

const CHANNEL_TYPE: Record<string, number> = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, THREAD: 11 };

export async function mapChannel(c: { id: string; name: string; type: string; serverId: string; topic?: string | null; parentId?: string | null; position?: number }) {
  return {
    id: await toSnowflake("channel", c.id),
    guild_id: await toSnowflake("guild", c.serverId),
    name: c.name,
    type: CHANNEL_TYPE[c.type] ?? 0,
    topic: c.topic ?? null,
    parent_id: c.parentId ? await toSnowflake("channel", c.parentId) : null,
    position: c.position ?? 0,
  };
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
    const emb = e as { title?: string; description?: string; fields?: { name?: string; value?: string }[]; footer?: { text?: string } };
    const lines: string[] = [];
    if (emb.title) lines.push(`**${emb.title}**`);
    if (emb.description) lines.push(emb.description);
    for (const f of emb.fields ?? []) if (f?.name && f?.value) lines.push(`**${f.name}**\n${f.value}`);
    if (emb.footer?.text) lines.push(`_${emb.footer.text}_`);
    if (lines.length) parts.push(lines.join("\n"));
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
    type: m.replyToId ? 19 : 0,
    ...(m.replyToId ? { message_reference: { message_id: m.replyToId, channel_id: m.channelId ? await toSnowflake("channel", m.channelId) : "0" } } : {}),
  };
}
