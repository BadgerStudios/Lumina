import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "@lumina/shared";
import { mergePreferences, resolvePreferences } from "./preferences.js";

describe("reading stored preferences", () => {
  it("is the defaults when nothing is stored", () => {
    expect(resolvePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(resolvePreferences("garbage")).toEqual(DEFAULT_PREFERENCES);
  });
  it("keeps stored values and fills the rest", () => {
    const r = resolvePreferences({ chat: { sendWithEnter: false }, notifications: { push: { direct: false } } });
    expect(r.chat.sendWithEnter).toBe(false);
    expect(r.chat.showMedia).toBe(true);
    expect(r.notifications.push.direct).toBe(false);
    expect(r.notifications.push.mention).toBe(true);
  });
  // A blob written by a newer or older app must never take the whole set down with it.
  it("drops values that no longer validate, leaf by leaf", () => {
    const r = resolvePreferences({ chat: { sendWithEnter: "yes", use24hClock: true }, accessibility: { fontScale: 300 }, future: { x: 1 } });
    expect(r.chat.sendWithEnter).toBe(true);
    expect(r.chat.use24hClock).toBe(true);
    expect(r.accessibility.fontScale).toBe(100);
  });
});

describe("changing preferences", () => {
  it("applies a partial change over what is stored", () => {
    const r = mergePreferences({ chat: { use24hClock: true } }, { accessibility: { fontScale: 125 } });
    expect(r.chat.use24hClock).toBe(true);
    expect(r.accessibility.fontScale).toBe(125);
  });
  it("refuses an invalid change with the path named", () => {
    expect(() => mergePreferences(null, { accessibility: { fontScale: 99 } })).toThrow(/accessibility\.fontScale/);
    expect(() => mergePreferences(null, { chat: { sendWithEnter: "no" } })).toThrow(/chat\.sendWithEnter/);
  });
  it("ignores keys it does not know rather than storing them", () => {
    const r = mergePreferences(null, { chat: { sendWithEnter: false }, mystery: true } as unknown);
    expect(r).not.toHaveProperty("mystery");
    expect(r.chat.sendWithEnter).toBe(false);
  });
});

describe("interface language", () => {
  it("is automatic by default and takes a known language", () => {
    expect(resolvePreferences(null).locale.language).toBe("auto");
    expect(mergePreferences(null, { locale: { language: "es" } }).locale.language).toBe("es");
    expect(mergePreferences({ locale: { language: "es" } }, { locale: { language: "auto" } }).locale.language).toBe("auto");
  });
  it("refuses an unknown language, and ignores one stored by some other build", () => {
    expect(() => mergePreferences(null, { locale: { language: "klingon" } })).toThrow(/locale.language/);
    expect(resolvePreferences({ locale: { language: "klingon" }, chat: { use24hClock: true } })).toMatchObject({ locale: { language: "auto" }, chat: { use24hClock: true } });
  });
});
