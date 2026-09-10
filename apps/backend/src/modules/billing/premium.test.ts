import { describe, expect, it } from "vitest";
import { isEntitlingStatus, isPremiumActive, uploadLimitsFor } from "./premium.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const future = new Date("2026-10-10T12:00:00.000Z");
const past = new Date("2026-08-10T12:00:00.000Z");

describe("isPremiumActive", () => {
  it("entitles while the paid period is still running", () => {
    expect(isPremiumActive(future, NOW)).toBe(true);
  });

  it("expires by itself once the period ends", () => {
    // The whole reason this is a date and not a boolean: a webhook that never arrives cannot
    // leave someone entitled forever.
    expect(isPremiumActive(past, NOW)).toBe(false);
  });

  it("treats the exact expiry instant as over", () => {
    expect(isPremiumActive(NOW, NOW)).toBe(false);
  });

  it.each([
    ["never subscribed", null],
    ["undefined", undefined],
  ])("does not entitle when %s", (_label, value) => {
    expect(isPremiumActive(value as Date | null | undefined, NOW)).toBe(false);
  });
});

describe("isEntitlingStatus", () => {
  it.each(["ACTIVE", "TRIALING", "PAST_DUE"])("keeps the perks while %s", (status) => {
    expect(isEntitlingStatus(status)).toBe(true);
  });

  it.each(["CANCELED", "INCOMPLETE", "UNPAID", "", "active"])("does not entitle on %s", (status) => {
    expect(isEntitlingStatus(status)).toBe(false);
  });
});

describe("uploadLimitsFor", () => {
  it("gives a subscriber more room than a free account", () => {
    const free = uploadLimitsFor(null, NOW);
    const paid = uploadLimitsFor(future, NOW);
    expect(paid.attachmentBytes).toBeGreaterThan(free.attachmentBytes);
    expect(paid.videoBytes).toBeGreaterThan(free.videoBytes);
  });

  it("drops a lapsed subscriber back to the free limits", () => {
    expect(uploadLimitsFor(past, NOW)).toEqual(uploadLimitsFor(null, NOW));
  });

  it("returns whole byte counts, not megabytes", () => {
    expect(uploadLimitsFor(null, NOW).attachmentBytes % (1024 * 1024)).toBe(0);
  });
});
