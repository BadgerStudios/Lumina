import { prisma } from "../../db/prisma.js";
import { serverEmojis, type ServerEmoji } from "../emoji/serverEmojiCache.js";
import { toSnowflake, fromSnowflake } from "./ids.js";

/**
 * Custom emoji across the Discord boundary.
 *
 * Lumina writes a custom emoji as `:name:` and resolves the name inside the space; a custom reaction
 * is stored under that same `:name:` token. Discord writes `<:name:id>` (`<a:name:id>` animated) in
 * text, names a reaction `name:id` in the URL, and lists a guild's emoji with snowflake ids. Bots
 * therefore saw bare `:name:` text they could not match, got `{ id: null }` reactions they took for
 * unicode, and had no emoji list to learn ids from — and a custom reaction a bot added arrived as a
 * plain text reaction called `name`.
 */

const LUMINA_TOKEN = /:([a-z0-9_]{2,32}):/g;
const DISCORD_TOKEN = /<a?:([A-Za-z0-9_]{2,32}):\d{1,20}>/g;

export async function mapEmoji(e: ServerEmoji) {
  return {
    id: await toSnowflake("emoji", e.id),
    name: e.name,
    roles: [],
    require_colons: true,
    managed: false,
    animated: e.animated,
    available: true,
  };
}

export async function guildEmojis(serverId: string) {
  return Promise.all((await serverEmojis(serverId)).map(mapEmoji));
}

/** Lumina text → Discord text: a `:name:` that names one of this space's emoji becomes `<:name:id>`. */
export async function contentToDiscord(content: string, serverId?: string | null): Promise<string> {
  if (!serverId || !content || !content.includes(":")) return content;
  const emojis = await serverEmojis(serverId);
  if (emojis.length === 0) return content;
  const byName = new Map(emojis.map((e) => [e.name, e]));
  const ids = new Map<string, string>();
  for (const match of content.matchAll(LUMINA_TOKEN)) {
    const e = byName.get(match[1]);
    if (e && !ids.has(e.name)) ids.set(e.name, await toSnowflake("emoji", e.id));
  }
  if (ids.size === 0) return content;
  return content.replace(LUMINA_TOKEN, (token, name: string) => {
    const id = ids.get(name);
    return id ? `<${byName.get(name)!.animated ? "a" : ""}:${name}:${id}>` : token;
  });
}

/** Discord text → Lumina text: `<:name:id>` and `<a:name:id>` become `:name:`. */
export function contentFromDiscord(content: string): string;
export function contentFromDiscord(content: string | undefined): string | undefined;
export function contentFromDiscord(content: string | undefined): string | undefined {
  if (!content || !content.includes("<")) return content;
  return content.replace(DISCORD_TOKEN, (_token, name: string) => `:${name.toLowerCase()}:`);
}

/** A stored reaction key (a unicode character, or `:name:` for a custom emoji) → Discord's emoji object. */
export async function reactionEmojiToDiscord(emoji: string, serverId?: string | null) {
  const m = /^:([a-z0-9_]{2,32}):$/.exec(emoji);
  if (m && serverId) {
    const e = (await serverEmojis(serverId)).find((row) => row.name === m[1]);
    if (e) return { id: await toSnowflake("emoji", e.id), name: e.name, animated: e.animated };
  }
  return { id: null, name: emoji };
}

/** Parses Discord's reaction URL segment: `name:id` or `a:name:id` for custom, else the unicode emoji. */
export function parseReactionParam(param: string): { custom: { name: string; id: string } | null; unicode: string } {
  let decoded = param;
  try {
    decoded = decodeURIComponent(param);
  } catch {
    /* already decoded */
  }
  const m = /^(?:a:)?([A-Za-z0-9_]{2,32}):(\d{1,20})$/.exec(decoded);
  return m ? { custom: { name: m[1], id: m[2] }, unicode: decoded } : { custom: null, unicode: decoded };
}

/** Discord's reaction URL segment → the key Lumina stores reactions under. */
export async function reactionKeyFromDiscord(param: string): Promise<string> {
  const { custom, unicode } = parseReactionParam(param);
  if (!custom) return unicode;
  const luminaId = await fromSnowflake("emoji", custom.id);
  if (luminaId) {
    const row = await prisma.customEmoji.findUnique({ where: { id: luminaId }, select: { name: true } });
    if (row) return `:${row.name}:`;
  }
  return `:${custom.name.toLowerCase()}:`;
}
