import { describe, expect, it } from "vitest";
import { aggregateViewWeights, utcMidnight } from "./pools.js";
import { allocatePool, splitRevenue } from "./split.js";

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("aggregateViewWeights", () => {
  it("sums views per author, only for APPROVED videos with a living author", () => {
    const weights = aggregateViewWeights([
      { views: 10, authorId: "a", videoStatus: "APPROVED" },
      { views: 5, authorId: "a", videoStatus: "APPROVED" },
      { views: 99, authorId: "a", videoStatus: "REMOVED" },
      { views: 7, authorId: "b", videoStatus: "APPROVED" },
      { views: 50, authorId: null, videoStatus: "APPROVED" },
      { views: 0, authorId: "c", videoStatus: "APPROVED" },
      { views: -3, authorId: "c", videoStatus: "APPROVED" },
    ]);
    expect(weights.get("a")).toBe(15n);
    expect(weights.get("b")).toBe(7n);
    expect(weights.has("c")).toBe(false);
  });
});

describe("utcMidnight", () => {
  it("floors to midnight UTC regardless of time of day", () => {
    const d = utcMidnight(new Date("2026-08-13T23:59:59.999Z"));
    expect(d.toISOString()).toBe("2026-08-13T00:00:00.000Z");
    expect(utcMidnight(new Date("2026-08-13T00:00:00.000Z")).toISOString()).toBe("2026-08-13T00:00:00.000Z");
  });
});

describe("pool → per-creator split — end-to-end conservation", () => {
  // The invariant the whole ad pool rests on: allocate a pool across creators, split each slice
  // under the ad_feed policy, and every unit of the original pool is accounted for exactly —
  // creators + platform + reserve + allocation residual === pool. No unit minted, none lost.
  const AD_FEED = { creatorBps: 5500, platformBps: 4500, reserveBps: 500 };

  it("conserves every unit across 1000 random pool days", () => {
    const rand = mulberry32(20260813);
    for (let trial = 0; trial < 1000; trial++) {
      const poolMinor = BigInt(Math.floor(rand() * 5_000_000)); // up to $50k in cents
      const creatorCount = 1 + Math.floor(rand() * 40);
      const weights = Array.from({ length: creatorCount }, (_, i) => ({
        key: `creator-${i}`,
        weight: BigInt(Math.floor(rand() * 10_000)),
      }));

      const { allocations, residualMinor } = allocatePool(poolMinor, weights);

      let accounted = residualMinor;
      for (const gross of allocations.values()) {
        const split = splitRevenue(gross, AD_FEED);
        expect(split.creatorMinor + split.platformMinor + split.reserveMinor).toBe(gross);
        accounted += gross;
      }
      expect(accounted).toBe(poolMinor);
    }
  });

  it("an all-zero-weight day leaves the entire pool as residual, allocating nothing", () => {
    const { allocations, residualMinor } = allocatePool(12345n, [
      { key: "a", weight: 0n },
      { key: "b", weight: 0n },
    ]);
    expect(allocations.size).toBe(0);
    expect(residualMinor).toBe(12345n);
  });
});
