/**
 * Deterministic rotation for the Discover surface.
 *
 * The operator's requirement was explicit: "rotated, not always the same users on there." A plain
 * top-N by score fails that in a structural way — whoever is popular today gets the exposure that
 * makes them more popular tomorrow, and the panel fossilises into the same faces forever. The
 * cure is not randomness per request (the page would reshuffle on every refresh and look broken);
 * it is a *seeded* shuffle over a candidate pool, where the seed changes on a fixed clock.
 *
 * Properties this buys, each of them load-bearing:
 *
 *  - **Stable within a window.** Everyone sees the same set for ROTATION_WINDOW_MS, and a refresh
 *    does not reshuffle. That also makes the response trivially cacheable.
 *  - **Different across windows.** The seed is the window index, so the selection genuinely
 *    changes several times a day without any state, sweep, or history table.
 *  - **Identical across replicas.** No Math.random(): two backend processes answer the same
 *    window with the same set, so a load-balanced pair can't flicker between answers.
 *  - **Everyone in the pool gets airtime.** The pool is already "the good ones" (top POOL_SIZE by
 *    score); the shuffle decides which of them are on screen *this window*, not whether they ever
 *    appear.
 */

export const ROTATION_WINDOW_MS = 6 * 60 * 60 * 1000; // four rotations a day

/** mulberry32 — tiny, deterministic, and plenty for shuffling a list of fifty. Not for anything
 * security-adjacent, which is why it lives here and not in a crypto helper. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function currentWindow(now = Date.now()): number {
  return Math.floor(now / ROTATION_WINDOW_MS);
}

/**
 * Pick `count` items from `pool`, deterministically for a given (seed window, salt).
 *
 * `salt` keeps the different Discover sections from rotating in lockstep — without it, the
 * people, servers and videos panels would all "change over" at the same instant with the same
 * relative ordering, which reads as a glitch rather than freshness.
 */
export function rotate<T>(pool: T[], count: number, window: number, salt: string): T[] {
  if (pool.length <= count) return [...pool];
  const rand = mulberry32(hashString(`${window}:${salt}`));
  const items = [...pool];
  // Fisher-Yates, driven by the seeded generator.
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items.slice(0, count);
}

/** When the current selection expires — surfaced to clients so they can say "refreshes in 3h"
 * instead of leaving people to wonder why the page never changes. */
export function rotatesAt(now = Date.now()): Date {
  return new Date((currentWindow(now) + 1) * ROTATION_WINDOW_MS);
}
