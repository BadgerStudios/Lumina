import { describe, expect, it } from "vitest";
import { canContact, checkContact } from "./service.js";

const adult = { isMinor: false, ageRecordedAt: new Date("2026-01-01") };
const minor = { isMinor: true, ageRecordedAt: new Date("2026-01-01") };
const unknown = { isMinor: false, ageRecordedAt: null };

/**
 * Contact separation is a 3×3 matrix, which is precisely the shape of thing that is cheap to test
 * exhaustively and expensive to reason about in your head. The old implementation folded "unknown"
 * into "minor" and got two cells wrong in opposite directions at once.
 */
describe("checkContact", () => {
  it("allows adult to adult", () => {
    expect(checkContact(adult, adult)).toBe("ok");
    expect(canContact(adult, adult)).toBe(true);
  });

  it("allows minor to minor", () => {
    expect(checkContact(minor, minor)).toBe("ok");
  });

  it("separates minors and adults in BOTH directions", () => {
    // Both, because a rule enforced one way round is not a rule — the person it protects is
    // whichever one happens to click first.
    expect(checkContact(adult, minor)).toBe("age-mismatch");
    expect(checkContact(minor, adult)).toBe("age-mismatch");
  });

  it("refuses an account whose own age is unrecorded", () => {
    // The behaviour that changed. Previously this returned true against another unknown account,
    // because both were read as minors — so on this instance 385 of 435 accounts formed one large
    // mutually-contactable "minor" cohort while being blocked from everyone who had answered.
    expect(checkContact(unknown, adult)).toBe("unknown-self");
    expect(checkContact(unknown, minor)).toBe("unknown-self");
    expect(checkContact(unknown, unknown)).toBe("unknown-self");
    expect(canContact(unknown, unknown)).toBe(false);
  });

  it("refuses contact with an account whose age is unrecorded", () => {
    expect(checkContact(adult, unknown)).toBe("unknown-other");
    expect(checkContact(minor, unknown)).toBe("unknown-other");
  });

  it("reports the caller's own missing age in preference to the other party's", () => {
    // Ordering matters for the message shown: your own missing age is the one you can fix, so it
    // must win over "that account hasn't finished setting up".
    expect(checkContact(unknown, unknown)).toBe("unknown-self");
  });

  it("never returns ok when either side is unrecorded", () => {
    // The property that actually matters, asserted over the whole matrix rather than case by case:
    // an unanswered age is never permission.
    for (const a of [adult, minor, unknown]) {
      for (const b of [adult, minor, unknown]) {
        if (a.ageRecordedAt === null || b.ageRecordedAt === null) {
          expect(canContact(a, b)).toBe(false);
        }
      }
    }
  });
});
