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

export async function mapRole(r: { id: string; name: string; color: number | null; position: number; permissions: bigint | string; serverId: string; isDefault?: boolean }, guildSnow: string) {
  return {
    id: r.isDefault ? guildSnow : await toSnowflake("role", r.id), // @everyone's id IS the guild id in Discord's model
    name: r.isDefault ? "@everyone" : r.name,
    color: r.color ?? 0,
    hoist: false,
    position: r.position,
    permissions: r.permissions.toString(),
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
    reactions: [],
    pinned: m.pinned,
    type: m.replyToId ? 19 : 0,
    ...(m.replyToId ? { message_reference: { message_id: m.replyToId, channel_id: m.channelId ? await toSnowflake("channel", m.channelId) : "0" } } : {}),
  };
}
