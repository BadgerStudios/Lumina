import { parseBigIntId } from "./parseBigIntId.js";

/**
 * Cursor pagination helpers for BigInt message ids. Messages are always
 * fetched newest-first with an optional `before` cursor (exclusive).
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function parseCursor(raw: string | undefined): bigint | undefined {
  // Via the shared parser so an out-of-int8-range numeric cursor (which BigInt() builds WITHOUT
  // throwing, then Postgres rejects with a 500) is treated as "no cursor" rather than crashing.
  return parseBigIntId(raw) ?? undefined;
}

export function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), MAX_PAGE_SIZE);
}
