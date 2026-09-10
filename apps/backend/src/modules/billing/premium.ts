import { env } from "../../config/env.js";

/**
 * What being a Premium subscriber entitles you to, and whether you are one.
 *
 * The plan is sold as "Higher upload limits, larger video uploads, and a profile badge" and
 * enforced none of it — there was no `isPremium` in the backend at all, and both upload limits
 * were single global constants with no per-plan branch.
 *
 * Everything here is pure and takes the stored date, so it can be tested without a database
 * and cannot disagree with itself between the upload path, the video path and the badge.
 */

export const PREMIUM_PLAN_KEY = "premium_monthly";

/**
 * Subscription statuses that keep the perks.
 *
 * PAST_DUE is included on purpose. It is the window where Stripe is retrying a card, not a
 * decision that someone has stopped paying, and cutting a paying customer off the instant a
 * card blips is hostile. Stripe moves the subscription to `unpaid`/`canceled` once retries are
 * exhausted, so the grace is bounded rather than open-ended.
 */
export const PREMIUM_ENTITLING_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const;
export type PremiumEntitlingStatus = (typeof PREMIUM_ENTITLING_STATUSES)[number];

export function isEntitlingStatus(status: string): status is PremiumEntitlingStatus {
  return (PREMIUM_ENTITLING_STATUSES as readonly string[]).includes(status);
}

/** Whether a stored `premiumUntil` still entitles, as of `now`. */
export function isPremiumActive(premiumUntil: Date | null | undefined, now: Date = new Date()): boolean {
  return premiumUntil instanceof Date && premiumUntil.getTime() > now.getTime();
}

export interface UploadLimits {
  /** Chat attachments and other ordinary uploads. */
  attachmentBytes: number;
  /** The video feed, which has always had its own larger ceiling. */
  videoBytes: number;
}

export function uploadLimitsFor(premiumUntil: Date | null | undefined, now: Date = new Date()): UploadLimits {
  const premium = isPremiumActive(premiumUntil, now);
  return {
    attachmentBytes: (premium ? env.PREMIUM_MAX_UPLOAD_MB : env.MAX_UPLOAD_MB) * 1024 * 1024,
    videoBytes: (premium ? env.PREMIUM_MAX_VIDEO_UPLOAD_MB : env.MAX_VIDEO_UPLOAD_MB) * 1024 * 1024,
  };
}
