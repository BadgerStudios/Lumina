import type { AgeBracket } from "@prisma/client";

/**
 * Age handling.
 *
 * The platform makes exactly one decision from age: whether an account is a minor, which then
 * prevents contact between minors and adults. Everything here exists to serve that decision as
 * accurately as possible while collecting as little as possible.
 */

/**
 * Lumina is an adults-only platform: 18 and over, no minor tier.
 *
 * `MINIMUM_AGE` is who may hold an account at all; `ADULT_AGE` is the contact-separation and
 * money-surface boundary. They are the SAME number on purpose. A 16–17 "supervised minor" tier
 * existed briefly (parent-paired accounts, separated from adults); the operator withdrew it on
 * 2026-08-24 — the review flow's only real outcome for a minor was restricting the account, and
 * the honest product statement is simply "18+". The minor-handling code paths (parental links,
 * contact separation, isMinor) are kept so an account found to be under 18 after the fact is
 * still walled off while it is dealt with, but no new minor account can be created.
 *
 * If this is ever lowered again, that is a legal question (GDPR digital-consent ages, COPPA
 * below 13) before it is an engineering one.
 */
export const MINIMUM_AGE = 18;
export const ADULT_AGE = 18;

/**
 * How long a device is stopped from creating NEW accounts after an under-age signup attempt.
 *
 * Deliberately a cooldown on signups, not a permanent device ban, and not a login ban:
 *
 *  - It has to stop the obvious retry — refuse someone, and the next thing they do is re-enter a
 *    different birthday. 30 days makes that pointless.
 *  - A PERMANENT ban would punish the person who answered honestly while the one who lied gets
 *    straight in. That inverts the incentive the whole age question depends on: the moment being
 *    truthful is the losing move, the age data stops meaning anything and the contact separation
 *    built on it stops working.
 *  - A device is not a person. Phones and computers are shared with siblings, parents and partners,
 *    and fingerprints collide across identical machines — a permanent ban takes out everyone who
 *    touches that hardware, forever.
 *  - The condition expires on its own. A 15-year-old is eligible in three years; a permanent ban
 *    outlives the reason for it and throws away a legitimate future user and their household.
 *
 * Existing accounts on the device keep working — this blocks registration, not access.
 */
export const UNDERAGE_SIGNUP_COOLDOWN_DAYS = 30;

/** Whole years elapsed, not a day-count division — leap years make the naive version wrong by a day
 * around birthdays, which is exactly where the 18 boundary matters most. */
export function ageFromBirthDate(birthDate: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) age -= 1;
  return age;
}

export function bracketFromAge(age: number): AgeBracket {
  if (age < 18) return "UNDER_18";
  if (age <= 24) return "AGE_18_24";
  if (age <= 34) return "AGE_25_34";
  if (age <= 49) return "AGE_35_49";
  return "AGE_50_PLUS";
}

export function isMinorBracket(bracket: AgeBracket): boolean {
  return bracket === "UNDER_18";
}

export type AgeCheckResult =
  | { ok: true; bracket: AgeBracket; isMinor: boolean }
  | { ok: false; reasonCode: "AGE_UNDER_MINIMUM" | "AGE_MISMATCH"; bracket: AgeBracket; isMinor: boolean };

/**
 * Reconciles the selected bracket against the birth date.
 *
 * The birth date is treated as authoritative wherever the two merely disagree about which ADULT
 * band someone falls in — picking "25-34" the year you turn 35 is an honest mistake, and blocking
 * an account over it would punish a precision the question never asked for.
 *
 * A disagreement that CROSSES the 18 boundary is different in kind: one answer claims an adult and
 * the other a minor, and that is the single distinction this whole system exists to get right. Those
 * are held for a human rather than silently resolved, because guessing wrong is harmful in both
 * directions — wrongly treating an adult as a minor is an annoyance, wrongly treating a minor as an
 * adult is the exact thing this is meant to prevent.
 */
export function checkAge(selected: AgeBracket, birthDate: Date, now = new Date()): AgeCheckResult {
  const age = ageFromBirthDate(birthDate, now);
  const derived = bracketFromAge(age);
  const derivedMinor = age < ADULT_AGE;

  // Either answer saying "under 18" is decisive on an 18+ platform: the person has told us they
  // are not eligible, and there is nothing to reconcile. Refused before any account row exists.
  if (age < MINIMUM_AGE || isMinorBracket(selected)) {
    return { ok: false, reasonCode: "AGE_UNDER_MINIMUM", bracket: derived, isMinor: true };
  }

  // Both answers claim an adult; they can still disagree with each other about the 18 boundary
  // only if the derived age is a minor, which the check above already refused. Kept as the
  // documented outcome for a future bracket/date disagreement rather than silently resolving one.
  if (isMinorBracket(selected) !== derivedMinor) {
    // Held for a human rather than silently resolved: one answer claims an adult and the other a
    // minor, and that is the single distinction this whole system exists to get right. Guessing
    // wrong is harmful in both directions, so neither reading is taken.
    return { ok: false, reasonCode: "AGE_MISMATCH", bracket: derived, isMinor: true };
  }

  return { ok: true, bracket: derived, isMinor: derivedMinor };
}

/**
 * Whether two accounts may contact each other.
 *
 * Three outcomes, not two, and the third is the point of this function.
 *
 * ## Why "unknown" is no longer folded into "minor"
 *
 * It used to be: a null `ageRecordedAt` was read as a minor, on the reasoning that the restrictive
 * default is the safe one. Safe, but wrong in practice — at the time, the overwhelming majority of
 * accounts predated age collection, so nearly the whole user base was silently classified as
 * children and quietly prevented from talking to anyone who had answered. Nothing told them why.
 * From the inside it looked like the app was broken. (The specific counts that used to be quoted
 * here were from an earlier dataset and had drifted an order of magnitude from reality; measure
 * against the database rather than trusting a number in a comment.)
 *
 * Worse, it made the restriction meaningless in the direction that matters: all those unknown
 * accounts *could* freely contact each other, because two "minors" match. So the rule neither
 * protected anyone nor explained itself.
 *
 * Unknown is now its own answer, and the caller turns it into a prompt to finish setting up the
 * account. That is strictly safer than the old behaviour — an unknown account is now blocked from
 * contacting ANYONE, including other unknowns, until it answers — and it is actionable, which the
 * old behaviour was not.
 *
 * `unknown-self` and `unknown-other` are distinguished because they need different messages: one
 * person can fix their own missing age, and can do nothing about someone else's.
 */
export type ContactCheck = "ok" | "age-mismatch" | "unknown-self" | "unknown-other";

export function checkContact(
  a: { isMinor: boolean; ageRecordedAt: Date | null },
  b: { isMinor: boolean; ageRecordedAt: Date | null },
): ContactCheck {
  if (a.ageRecordedAt === null) return "unknown-self";
  if (b.ageRecordedAt === null) return "unknown-other";
  return a.isMinor === b.isMinor ? "ok" : "age-mismatch";
}

/**
 * Boolean form, for the places that only need "may these two interact".
 *
 * Unknown on either side is false — an unanswered age is not permission. This deliberately does NOT
 * reproduce the old "unknown counts as minor" behaviour, so two unknown accounts no longer match
 * each other.
 */
export function canContact(
  a: { isMinor: boolean; ageRecordedAt: Date | null },
  b: { isMinor: boolean; ageRecordedAt: Date | null },
): boolean {
  return checkContact(a, b) === "ok";
}
