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
 * Takes the age somebody states.
 *
 * The stated bracket is authoritative. The birth date is still collected and stored — it is what
 * lets an account age into adulthood on its own (see refreshMinorStatus) — but it no longer
 * overrules the answer to the question actually asked.
 *
 * Owner decision, 2026-09-14. The previous behaviour refused anyone whose typed birthday worked out
 * younger than the band they picked, which meant a mistyped year read as a minor and there was no
 * way for the person to correct it: the refusal happened before an account existed, so there was
 * nothing to edit. That misfires on honest people far more often than it catches anyone, because
 * lying is a question of which box you tick, not which date you type.
 *
 * What still refuses: SELECTING under-18. That is not a derivation or an inference — it is the
 * person answering the eligibility question with "no", and an 18+ platform has to take that answer.
 */
export function checkAge(selected: AgeBracket, birthDate: Date, now = new Date()): AgeCheckResult {
  const age = ageFromBirthDate(birthDate, now);
  const derived = bracketFromAge(age);

  // The one refusal left, and it is a direct answer rather than a computed one.
  if (isMinorBracket(selected)) {
    return { ok: false, reasonCode: "AGE_UNDER_MINIMUM", bracket: selected, isMinor: true };
  }

  // The stated bracket is what the account carries. `derived` is computed only so a caller that
  // wants to notice a large disagreement still can — nothing here acts on it.
  void derived;
  void age;
  return { ok: true, bracket: selected, isMinor: false };
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
