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
 * The signup boundary on an 18+ platform: two outcomes. Under 18 by either answer is refused
 * before any account exists; adults are admitted as non-minors.
 */
describe("checkAge", () => {
  const NOW = new Date("2026-08-13T00:00:00Z");
  const bornYearsAgo = (years: number, offsetDays = 0) => {
    const d = new Date(NOW);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    d.setUTCDate(d.getUTCDate() - offsetDays);
    return d;
  };

  it("admits a 16 year old as a minor", () => {
    const result = checkAge("UNDER_18", bornYearsAgo(16), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
    expect(result.bracket).toBe("UNDER_18");
  });
  it("refuses a 12 year old whatever bracket they pick — that is the legal floor", () => {
    for (const bracket of ["UNDER_18", "AGE_18_24"] as const) {
      const result = checkAge(bracket, bornYearsAgo(12), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe("AGE_UNDER_MINIMUM");
    }
  });

  it("admits a 17 year old as a minor", () => {
    const result = checkAge("UNDER_18", bornYearsAgo(17), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
  });

  it("takes the stated bracket even a day short of 18 by birth date", () => {
    // Changed 2026-09-14: the stated bracket decides. A birthday a day short of the boundary used
    // to refuse the account outright, before one existed to correct — which caught mistyped years
    // far more often than anyone dishonest, since lying is a question of which box you tick.
    const result = checkAge("AGE_18_24", bornYearsAgo(18, -1), NOW);
    expect(result.ok).toBe(true);
    expect(result.bracket).toBe("AGE_18_24");
    expect(result.isMinor).toBe(false);
  });

  it("admits someone on their 18th birthday", () => {
    const result = checkAge("AGE_18_24", bornYearsAgo(18), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(false);
  });

  it("admits an adult as a non-minor", () => {
    const result = checkAge("AGE_18_24", bornYearsAgo(20), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(false);
  });

  it("takes a self-declared minor at their word even with an adult birth date", () => {
    // The answer is what it is: someone who says "under 18" gets a minor account, whatever the
    // typed date says. Wrongly treating an adult as a minor costs them the adult surfaces until
    // they fix it; the other error is the one this whole module exists to prevent.
    const result = checkAge("UNDER_18", bornYearsAgo(30), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
  });

  it("takes an adult bracket even when the birth date disagrees", () => {
    // The birth date is still stored — it is what lets an account age into adulthood by itself —
    // but it no longer overrules the answer to the question actually asked.
    const result = checkAge("AGE_18_24", bornYearsAgo(16), NOW);
    expect(result.ok).toBe(true);
    expect(result.bracket).toBe("AGE_18_24");
    expect(result.isMinor).toBe(false);
  });

  it("admits anyone at least the minimum age who says they are under 18, as a minor", () => {
    const result = checkAge("UNDER_18", bornYearsAgo(MINIMUM_AGE), NOW);
    expect(result.ok).toBe(true);
    expect(result.isMinor).toBe(true);
  });

  it("keeps a minor tier between the minimum age and adulthood", () => {
    expect(MINIMUM_AGE).toBeLessThan(ADULT_AGE);
  });
});
