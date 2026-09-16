import { prisma } from "../../db/prisma.js";

/**
 * cuid ↔ numeric-snowflake mapping for the Discord compat layer.
 *
 * Discord libraries do BigInt math on ids (discord.js computes `BigInt(guildId) >> 22n` for
 * sharding before a single packet is sent), so every id we hand a compat client must be a
 * numeric string. Messages use their native BigInt ids untouched; cuid-keyed entities resolve
 * through CompatId rows — minted on first sight, stable forever after.
 */

export type CompatKind = "user" | "guild" | "channel" | "role";

const cache = new Map<string, string>(); // `${kind}:${luminaId}` -> snowflake, and the reverse

export async function toSnowflake(kind: CompatKind, luminaId: string): Promise<string> {
  const key = `${kind}:${luminaId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let row = await prisma.compatId.findUnique({ where: { kind_luminaId: { kind, luminaId } } });
  if (!row) {
    try {
      // Minted with a time-based id (see timeSnowflake) so libraries reading creation time off
      // a guild/channel/role id get today, not January 2015. Rows minted earlier keep their ids.
      row = await prisma.compatId.create({ data: { id: BigInt(timeSnowflake()), kind, luminaId } });
    } catch {
      // Raced with another mint of the same pair — the unique constraint means the winner's row
      // is the answer.
      row = await prisma.compatId.findUniqueOrThrow({ where: { kind_luminaId: { kind, luminaId } } });
    }
  }
  const snow = row.id.toString();
  cache.set(key, snow);
  cache.set(`${kind}#${snow}`, luminaId);
  return snow;
}

export async function fromSnowflake(kind: CompatKind, snowflake: string): Promise<string | null> {
  const hit = cache.get(`${kind}#${snowflake}`);
  if (hit) return hit;
  let id: bigint;
  try {
    id = BigInt(snowflake);
  } catch {
    return null;
  }
  const row = await prisma.compatId.findUnique({ where: { id } });
  if (!row || row.kind !== kind) return null;
  cache.set(`${kind}#${snowflake}`, row.luminaId);
  cache.set(`${kind}:${row.luminaId}`, snowflake);
  return row.luminaId;
}

/**
 * A Discord-style snowflake for entities that live only for the length of an exchange
 * (interactions). Libraries derive creation time from the id — JDA refuses to edit or follow up
 * an interaction whose id is older than fifteen minutes, and CompatId row numbers decode to
 * January 2015, so Ree6's deferred /ping could acknowledge but never post its answer. Layout is
 * Discord's: 42 bits of milliseconds since 2015-01-01, 10 zero bits, 12-bit sequence.
 */
const DISCORD_EPOCH_MS = 1420070400000n;
let snowflakeSeq = 0;
export function timeSnowflake(nowMs: number = Date.now()): string {
  snowflakeSeq = (snowflakeSeq + 1) & 0xfff;
  return (((BigInt(nowMs) - DISCORD_EPOCH_MS) << 22n) | BigInt(snowflakeSeq)).toString();
}
export function snowflakeTimeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}
