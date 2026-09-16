import { prisma } from "../../db/prisma.js";

/**
 * A space's custom emoji, briefly cached. The Discord compat layer rewrites `:name:` in every message
 * it hands a bot, which would otherwise be one query per message; the emoji routes drop a space's
 * entry the moment its emoji change, so the TTL only bounds staleness from anything that bypasses them.
 */
export type ServerEmoji = { id: string; name: string; animated: boolean };

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; rows: ServerEmoji[] }>();

export async function serverEmojis(serverId: string): Promise<ServerEmoji[]> {
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = await prisma.customEmoji.findMany({
    where: { serverId },
    select: { id: true, name: true, animated: true },
    orderBy: { createdAt: "asc" },
  });
  cache.set(serverId, { at: Date.now(), rows });
  return rows;
}

export function forgetServerEmojis(serverId: string): void {
  cache.delete(serverId);
}
