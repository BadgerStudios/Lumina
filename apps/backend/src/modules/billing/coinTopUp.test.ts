import { describe, expect, it } from "vitest";
import { coinTopUpFromMetadata } from "./coinTopUp.js";

describe("coinTopUpFromMetadata", () => {
  it("reads a well-formed top-up", () => {
    expect(coinTopUpFromMetadata({ userId: "u1", coins: "500", bundleKey: "starter" })).toEqual({
      userId: "u1",
      coins: 500,
      bundleKey: "starter",
    });
  });

  it("omits bundleKey rather than carrying an empty one", () => {
    expect(coinTopUpFromMetadata({ userId: "u1", coins: "10", bundleKey: "" })).toEqual({ userId: "u1", coins: 10 });
  });

  // Everything below must return null, or a refund reverses nothing while the credit stood.
  it.each([
    ["no metadata at all", null],
    ["undefined metadata", undefined],
    ["empty metadata", {}],
    ["a subscription or tip: no coins", { userId: "u1" }],
    ["no userId", { coins: "100" }],
    ["an empty userId", { userId: "", coins: "100" }],
    ["a non-numeric amount", { userId: "u1", coins: "lots" }],
    ["an empty amount", { userId: "u1", coins: "" }],
    ["a whitespace amount", { userId: "u1", coins: "   " }],
    ["zero", { userId: "u1", coins: "0" }],
    ["a negative amount", { userId: "u1", coins: "-100" }],
    ["Infinity", { userId: "u1", coins: "Infinity" }],
    ["NaN", { userId: "u1", coins: "NaN" }],
    // Both of these used to pass: Number.isFinite(1.5) is true, and 1e21 is finite too.
    ["a fractional amount", { userId: "u1", coins: "1.5" }],
    ["an amount past MAX_SAFE_INTEGER", { userId: "u1", coins: "1e21" }],
  ])("rejects %s", (_label, metadata) => {
    expect(coinTopUpFromMetadata(metadata as Record<string, string> | null | undefined)).toBeNull();
  });
});
