import { describe, expect, it } from "vitest";
import { rotate, currentWindow, ROTATION_WINDOW_MS } from "./rotation.js";

const pool = Array.from({ length: 50 }, (_, i) => `item-${i}`);

describe("rotate", () => {
  it("is deterministic for the same window and salt", () => {
    // The property that stops the page reshuffling on every refresh — and that keeps two backend
    // replicas answering identically.
    expect(rotate(pool, 8, 1234, "people")).toEqual(rotate(pool, 8, 1234, "people"));
  });

  it("changes between windows", () => {
    // The property the operator actually asked for: "rotated, not always the same users."
    const a = rotate(pool, 8, 1234, "people");
    const b = rotate(pool, 8, 1235, "people");
    expect(a).not.toEqual(b);
  });

  it("differs across salts within one window", () => {
    // Sections must not rotate in lockstep — same window, different panel, different order.
    const people = rotate(pool, 8, 1234, "people");
    const servers = rotate(pool, 8, 1234, "servers");
    expect(people).not.toEqual(servers);
  });

  it("returns the whole pool when it is smaller than the ask", () => {
    expect(rotate(["a", "b"], 8, 1, "x")).toEqual(["a", "b"]);
  });

  it("never invents or duplicates items", () => {
    const out = rotate(pool, 8, 999, "videos");
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBe(8);
    for (const item of out) expect(pool).toContain(item);
  });

  it("gives everyone in the pool airtime across windows", () => {
    // Rotation that still only ever showed the same dozen would be ranking wearing a costume.
    // 40 windows × 8 slots over a 50-item pool: every item should surface at least once.
    const seen = new Set<string>();
    for (let w = 0; w < 40; w++) for (const item of rotate(pool, 8, w, "people")) seen.add(item);
    expect(seen.size).toBe(pool.length);
  });

  it("does not mutate the pool", () => {
    const copy = [...pool];
    rotate(pool, 8, 42, "people");
    expect(pool).toEqual(copy);
  });
});

describe("currentWindow", () => {
  it("advances exactly once per window", () => {
    // Aligned to a window start — an arbitrary timestamp sits mid-window, and "t + WINDOW - 1"
    // then straddles a boundary, which is a fact about the test's choice of t, not the function.
    const t = Math.floor(1_800_000_000_000 / ROTATION_WINDOW_MS) * ROTATION_WINDOW_MS;
    expect(currentWindow(t + ROTATION_WINDOW_MS) - currentWindow(t)).toBe(1);
    expect(currentWindow(t + ROTATION_WINDOW_MS - 1)).toBe(currentWindow(t));
  });
});
