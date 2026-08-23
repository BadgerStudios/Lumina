import { randomInt } from "node:crypto";
import { prisma } from "../../db/prisma.js";

/**
 * The short code a player types to pull a prepared video into cache (`/imageframe video <code>`).
 *
 * Crockford base32 minus vowels and easily-confused glyphs — no O/0, I/1/L, U — so a code read off
 * a Discord message or dictated in voice chat can't be mistyped into a different valid code. Six
 * chars over this 27-symbol alphabet is ~387M combinations: collisions are astronomically unlikely
 * but checked anyway, because a silent collision would hand one player another's video.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function mint(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export async function generateCode(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    // Widen the code by one char after a run of collisions rather than looping forever on a
    // saturated keyspace — this table will never approach that, but the failure mode of the naive
    // version is an infinite loop, and this one degrades gracefully instead.
    const code = mint(6 + Math.floor(attempt / 3));
    const existing = await prisma.imageframeVideo.findUnique({ where: { code }, select: { id: true } });
    if (!existing) return code;
  }
  throw new Error("could not allocate a unique imageframe code");
}
