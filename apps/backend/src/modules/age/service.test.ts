import { describe, expect, it } from "vitest";
import { canContact, checkContact, checkAge, MINIMUM_AGE, ADULT_AGE } from "./service.js";

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

/**
 * The signup boundary, which now has THREE outcomes rather than two. The 16/17 band is the whole
 * point of the change — it used to be refused outright, which is what pushed exactly those people
 * into entering a fake birthday and defeating every downstream protection built on age.
 */
describe("checkAge", () => {
  const NOW = new Date("2026-08-13T00:00:00Z");
  const bornYearsAgo = (years: number, offsetDays = 0) => {
    const d = new Date(NOW);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    d.setUTCDate(d.getUTCDate() - offsetDays);
    return d;
  };

  it("admits a 16 year old as a MINOR rather than refusing them", () => {
    const result = checkAge("UNDER_18", bornYearsAgo(16), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
  });

  it("admits a 17 year old as a minor", () => {
    const result = checkAge("UNDER_18", bornYearsAgo(17), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
  });

  it("refuses someone one day short of the minimum", () => {
    // The boundary itself, not a comfortable distance from it — off-by-one here decides whether a
    // 15-year-old gets an account.
    const result = checkAge("UNDER_18", bornYearsAgo(16, -1), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("AGE_UNDER_MINIMUM");
  });

  it("admits an adult as a non-minor", () => {
    const result = checkAge("AGE_18_24", bornYearsAgo(20), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(false);
  });

  it("holds a bracket/birthdate disagreement that crosses 18, in both directions", () => {
    // An adult date with a minor bracket is the mis-click that blocked a real signup; a minor date
    // with an adult bracket is what someone trying to get past the gate looks like. Neither is
    // silently resolved.
    const minorBracketAdultDate = checkAge("UNDER_18", bornYearsAgo(30), NOW);
    const adultBracketMinorDate = checkAge("AGE_18_24", bornYearsAgo(16), NOW);
    expect(minorBracketAdultDate.ok).toBe(false);
    expect(adultBracketMinorDate.ok).toBe(false);
    if (!minorBracketAdultDate.ok) expect(minorBracketAdultDate.reasonCode).toBe("AGE_MISMATCH");
    if (!adultBracketMinorDate.ok) expect(adultBracketMinorDate.reasonCode).toBe("AGE_MISMATCH");
  });

  it("does not disagree with itself about where the boundaries are", () => {
    // Guards the constants, not the function: a minor tier only exists while MINIMUM_AGE < ADULT_AGE.
    // Setting them equal would silently delete the 16-17 band and quietly restore an 18+ platform.
    expect(MINIMUM_AGE).toBeLessThan(ADULT_AGE);
    for (let age = MINIMUM_AGE; age < ADULT_AGE; age++) {
      const result = checkAge("UNDER_18", bornYearsAgo(age), NOW);
      expect(result.ok).toBe(true);
      expect(result.isMinor).toBe(true);
    }
  });
});
