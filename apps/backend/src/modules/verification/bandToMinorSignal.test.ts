import { describe, expect, it } from "vitest";
import { bandToMinorSignal } from "./service.js";

/**
 * The band parser is safety-critical: its boolean decides whether a native device signal treats an
 * account as a minor (which LOCKS it). true = minor, false = adult, null = can't tell (ignore).
 * These lock in the real Apple/Google bucket shapes plus the fail-safe handling of ambiguous input.
 */
describe("bandToMinorSignal", () => {
  it("maps the real Apple/Google buckets correctly", () => {
    expect(bandToMinorSignal("18+")).toBe(false); // adult
    expect(bandToMinorSignal("16-17")).toBe(true); // minor
    expect(bandToMinorSignal("13-15")).toBe(true);
    expect(bandToMinorSignal("0-12")).toBe(true);
  });

  it("handles the textual/underscore forms and is case-insensitive", () => {
    expect(bandToMinorSignal("ADULT")).toBe(false);
    expect(bandToMinorSignal("over_18")).toBe(false);
    expect(bandToMinorSignal("18_plus")).toBe(false);
    expect(bandToMinorSignal("UNDER_18")).toBe(true);
    expect(bandToMinorSignal("under_16")).toBe(true);
    expect(bandToMinorSignal("16_17")).toBe(true);
  });

  it("resolves numeric ranges by the 18 boundary", () => {
    expect(bandToMinorSignal("18-24")).toBe(false); // wholly adult
    expect(bandToMinorSignal("20-25")).toBe(false);
    expect(bandToMinorSignal("10-15")).toBe(true); // wholly minor
    expect(bandToMinorSignal("13-17")).toBe(true);
  });

  it("returns null (fail-safe) for a range that SPANS the 18 boundary — never guesses adult", () => {
    // Includes 16/17-year-olds; resolving it either way would be wrong, so the signal is ignored.
    expect(bandToMinorSignal("16-20")).toBeNull();
    expect(bandToMinorSignal("17-30")).toBeNull();
  });

  it("handles a bare age number exactly", () => {
    expect(bandToMinorSignal("20")).toBe(false);
    expect(bandToMinorSignal("17")).toBe(true);
    expect(bandToMinorSignal("18")).toBe(false);
  });

  it("returns null for unknown / empty / unparseable input", () => {
    expect(bandToMinorSignal(null)).toBeNull();
    expect(bandToMinorSignal(undefined)).toBeNull();
    expect(bandToMinorSignal("")).toBeNull();
    expect(bandToMinorSignal("  ")).toBeNull();
    expect(bandToMinorSignal("banana")).toBeNull();
    expect(bandToMinorSignal("21+")).toBeNull(); // not the exact "18+" adult token, and unparseable
  });
});
