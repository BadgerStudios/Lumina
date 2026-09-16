import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/prisma.js", () => ({ prisma: {} }));

import { timeSnowflake, snowflakeTimeMs } from "./ids.js";

describe("time-based snowflakes", () => {
  // JDA: getTimeCreated() + 15 min < now  =>  InteractionExpiredException before any request.
  it("decode to the moment they were minted", () => {
    const now = Date.now();
    const id = timeSnowflake(now);
    expect(id).toMatch(/^[0-9]+$/);
    expect(snowflakeTimeMs(id)).toBe(now);
    expect(BigInt(id) < (1n << 63n)).toBe(true);
  });
  it("differ within the same millisecond", () => {
    const t = 1_800_000_000_000;
    expect(timeSnowflake(t)).not.toBe(timeSnowflake(t));
  });
});
