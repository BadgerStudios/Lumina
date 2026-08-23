/**
 * Parse a request-supplied id into a positive BigInt inside Postgres `bigint` (int8) range, or null.
 *
 * Two traps this closes, both of which turned malformed input into an unhandled 500 rather than a
 * clean 404:
 *  - `BigInt("abc")` THROWS — a bare `BigInt(param)` with no try/catch crashes the handler.
 *  - `BigInt("999999999999999999999999")` does NOT throw — it happily builds an out-of-range value
 *    that sails past a try/catch and only fails when Postgres rejects it (error 22003), also a 500.
 *
 * All ids in this codebase are positive autoincrement bigints, so anything non-numeric, negative, or
 * above int8 max is simply "not a valid id" → null, which callers turn into NotFound.
 */
const INT8_MAX = 9223372036854775807n;

export function parseBigIntId(raw: string | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  const value = BigInt(s);
  if (value < 1n || value > INT8_MAX) return null;
  return value;
}
