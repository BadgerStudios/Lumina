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
      row = await prisma.compatId.create({ data: { kind, luminaId } });
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
