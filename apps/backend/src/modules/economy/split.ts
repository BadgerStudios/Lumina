/**
 * Pure split arithmetic — deliberately free of database, Prisma, and IO so its invariants can be
 * property-tested exhaustively. Every function here answers one question: given a gross amount and
 * a policy, who is owed exactly what, such that the parts sum EXACTLY to the whole.
 *
 * Basis points, integer minor units, BigInt throughout. The classic failure this design forbids:
 * computing creator = gross * 0.55 and platform = gross * 0.45 independently and losing (or
 * minting) a cent to rounding. Here one side is derived by subtraction, so the identity
 * creator + platform + reserve == gross holds by construction, not by hope.
 */

export interface SplitPolicy {
  creatorBps: number;
  platformBps: number;
  reserveBps: number;
}

export interface SplitResult {
  creatorMinor: bigint;
  platformMinor: bigint;
  reserveMinor: bigint;
}

export function assertValidPolicy(p: SplitPolicy): void {
  if (!Number.isInteger(p.creatorBps) || !Number.isInteger(p.platformBps) || !Number.isInteger(p.reserveBps)) {
    throw new Error("Policy basis points must be integers");
  }
  if (p.creatorBps < 0 || p.platformBps < 0 || p.reserveBps < 0) throw new Error("Negative basis points");
  if (p.creatorBps + p.platformBps !== 10000) throw new Error("creator + platform must equal 10000 bps");
  if (p.reserveBps > p.creatorBps) throw new Error("Reserve cannot exceed the creator share");
}

/**
 * Split gross revenue. Floor the creator share (the platform absorbs the rounding cent, never the
 * creator being overpaid into money that does not exist), carve the reserve out of the creator's
 * portion, and derive the platform share by subtraction so the sum is exact.
 */
export function splitRevenue(grossMinor: bigint, policy: SplitPolicy): SplitResult {
  assertValidPolicy(policy);
  if (grossMinor < 0n) throw new Error("Gross must be non-negative");

  const creatorTotal = (grossMinor * BigInt(policy.creatorBps)) / 10000n; // floor
  const reserveMinor = (creatorTotal * BigInt(policy.reserveBps)) / 10000n;
  const creatorMinor = creatorTotal - reserveMinor;
  const platformMinor = grossMinor - creatorTotal;
  return { creatorMinor, platformMinor, reserveMinor };
}

/**
 * Allocate a finalized pool across weighted participants deterministically.
 *
 * Largest-remainder method: exact proportional shares floored, then the leftover units handed out
 * one each in remainder order (ties broken by stable key order so two replicas allocate
 * identically). The residue after integer division of the WHOLE pool goes to the caller's
 * residual bucket — visible, never minted.
 */
export function allocatePool(
  poolMinor: bigint,
  weights: { key: string; weight: bigint }[],
): { allocations: Map<string, bigint>; residualMinor: bigint } {
  const allocations = new Map<string, bigint>();
  const positive = weights.filter((w) => w.weight > 0n);
  const total = positive.reduce((s, w) => s + w.weight, 0n);
  if (poolMinor <= 0n || total === 0n) return { allocations, residualMinor: poolMinor > 0n ? poolMinor : 0n };

  const floors: { key: string; floor: bigint; remainder: bigint }[] = positive.map((w) => {
    const exactNumerator = poolMinor * w.weight;
    return { key: w.key, floor: exactNumerator / total, remainder: exactNumerator % total };
  });
  let assigned = floors.reduce((s, f) => s + f.floor, 0n);
  let leftover = poolMinor - assigned;

  // Hand leftover units to the largest remainders, deterministically.
  const order = [...floors].sort((a, b) => (a.remainder === b.remainder ? (a.key < b.key ? -1 : 1) : b.remainder > a.remainder ? 1 : -1));
  for (const f of order) {
    if (leftover <= 0n) break;
    f.floor += 1n;
    leftover -= 1n;
  }
  for (const f of floors) if (f.floor > 0n) allocations.set(f.key, f.floor);
  return { allocations, residualMinor: leftover };
}

/** Mee6-style level curve: XP required to go from `level` to `level+1`. */
export function xpForLevel(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP → level, the inverse of the cumulative curve. */
export function levelForXp(totalXp: number): number {
  let level = 0;
  let remaining = totalXp;
  for (;;) {
    const need = xpForLevel(level);
    if (remaining < need) return level;
    remaining -= need;
    level++;
    if (level > 500) return 500; // sanity ceiling; nobody is level 501 by talking
  }
}
