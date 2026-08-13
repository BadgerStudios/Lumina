import { describe, expect, it } from "vitest";
import { splitRevenue, allocatePool, assertValidPolicy, levelForXp, xpForLevel } from "./split.js";

/**
 * Property tests over randomized inputs — the financial invariants proven by generation, not by
 * examples. Seeded PRNG so a failure reproduces exactly.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("splitRevenue — conservation properties", () => {
  it("creator + platform + reserve == gross, for thousands of random cases", () => {
    const rand = mulberry32(20260813);
    for (let i = 0; i < 5000; i++) {
      const gross = BigInt(Math.floor(rand() * 10_000_000)); // up to $100k
      const creatorBps = Math.floor(rand() * 10001);
      // Reserve is drawn WITHIN the creator share — the validator forbids a reserve larger than
      // the share it is carved from, and the first run of this generator proved the validator
      // works by tripping it.
      const policy = {
        creatorBps,
        platformBps: 10000 - creatorBps,
        reserveBps: Math.floor(rand() * (Math.min(2000, creatorBps) + 1)),
      };
      const r = splitRevenue(gross, policy);
      // The one identity that matters: no cent minted, no cent lost.
      expect(r.creatorMinor + r.platformMinor + r.reserveMinor).toBe(gross);
      expect(r.creatorMinor).toBeGreaterThanOrEqual(0n);
      expect(r.platformMinor).toBeGreaterThanOrEqual(0n);
      expect(r.reserveMinor).toBeGreaterThanOrEqual(0n);
    }
  });

  it("the creator never receives more than policy allows", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 2000; i++) {
      const gross = BigInt(Math.floor(rand() * 1_000_000));
      const r = splitRevenue(gross, { creatorBps: 5500, platformBps: 4500, reserveBps: 0 });
      expect(r.creatorMinor * 10000n <= gross * 5500n).toBe(true);
    }
  });

  it("rejects malformed policies loudly", () => {
    expect(() => assertValidPolicy({ creatorBps: 5000, platformBps: 4000, reserveBps: 0 })).toThrow();
    expect(() => assertValidPolicy({ creatorBps: -1, platformBps: 10001, reserveBps: 0 })).toThrow();
    expect(() => assertValidPolicy({ creatorBps: 1000, platformBps: 9000, reserveBps: 2000 })).toThrow();
    expect(() => splitRevenue(-1n, { creatorBps: 5500, platformBps: 4500, reserveBps: 0 })).toThrow();
  });
});

describe("allocatePool — pool distribution properties", () => {
  it("allocations + residual == pool, and allocation is deterministic, for random pools", () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 1500; i++) {
      const pool = BigInt(Math.floor(rand() * 5_000_000));
      const n = 1 + Math.floor(rand() * 40);
      const weights = Array.from({ length: n }, (_, k) => ({
        key: `c${k}`,
        weight: BigInt(Math.floor(rand() * 10_000)),
      }));
      const a = allocatePool(pool, weights);
      const b = allocatePool(pool, weights);
      const sumA = [...a.allocations.values()].reduce((s, v) => s + v, 0n);
      expect(sumA + a.residualMinor).toBe(pool);
      // Determinism: identical inputs → identical map, entry for entry.
      expect([...a.allocations.entries()]).toEqual([...b.allocations.entries()]);
      // Nobody with zero weight is ever paid.
      for (const w of weights) if (w.weight === 0n) expect(a.allocations.has(w.key)).toBe(false);
    }
  });

  it("weight order does not change anyone's allocation", () => {
    const weights = [
      { key: "a", weight: 333n }, { key: "b", weight: 333n }, { key: "c", weight: 334n },
    ];
    const forward = allocatePool(1000n, weights);
    const backward = allocatePool(1000n, [...weights].reverse());
    for (const k of ["a", "b", "c"]) {
      expect(forward.allocations.get(k)).toBe(backward.allocations.get(k));
    }
  });

  it("an empty or zero-weight pool leaves the whole pool as residual, never lost", () => {
    expect(allocatePool(500n, []).residualMinor).toBe(500n);
    expect(allocatePool(500n, [{ key: "x", weight: 0n }]).residualMinor).toBe(500n);
  });
});

describe("level curve", () => {
  it("is monotonic and consistent with its inverse", () => {
    let total = 0;
    for (let level = 0; level < 60; level++) {
      expect(levelForXp(total)).toBe(level);
      expect(levelForXp(total + xpForLevel(level) - 1)).toBe(level);
      total += xpForLevel(level);
    }
  });
});
