/**
 * Cursor pagination helpers for BigInt message ids. Messages are always
 * fetched newest-first with an optional `before` cursor (exclusive).
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function parseCursor(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  try {
    const value = BigInt(raw);
    if (value < 0n) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), MAX_PAGE_SIZE);
}
