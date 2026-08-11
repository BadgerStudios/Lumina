import Stripe from "stripe";
import { env } from "../../config/env.js";

/**
 * Stripe client, created lazily and only when a secret key is actually configured.
 *
 * Everything billing-related is written so the app runs correctly with no Stripe credentials at all
 * — the same graceful-degradation pattern TURN and Web Push already use here. That is not just for
 * convenience: it means the entire flow (models, ledger, webhook handling, dashboard panels) is
 * built and testable before any real money is involved, and goes live by adding env vars rather
 * than by changing code.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      // Pinned rather than floating: Stripe ships breaking changes behind version bumps, and an
      // unpinned client can start behaving differently after an unrelated dependency update. Must
      // match the version this installed SDK was built against — the types enforce that.
      apiVersion: "2026-07-29.dahlia",
      // Stripe's own retry logic, for transient network failures only (it never retries a request
      // that may have already created a charge).
      maxNetworkRetries: 2,
    });
  }
  return client;
}

export function isBillingConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Webhooks are only trusted when a signing secret exists to verify them against. */
export function isWebhookConfigured(): boolean {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

/**
 * The plans on offer. Deliberately defined in code rather than read from Stripe at runtime: the
 * price id is the only thing Stripe needs to know about, and keeping the catalogue here means the
 * app has a stable `planKey` to store and reason about even if prices are re-created in Stripe.
 *
 * `priceId` is read from the environment because it differs between test and live mode — hardcoding
 * one guarantees a broken checkout in the other.
 */
export interface PlanDefinition {
  key: string;
  name: string;
  description: string;
  priceIdEnvVar: string;
}

export const PLANS: PlanDefinition[] = [
  {
    key: "premium_monthly",
    name: "Lumina Premium",
    description: "Higher upload limits, larger video uploads, and a profile badge.",
    priceIdEnvVar: "STRIPE_PRICE_PREMIUM_MONTHLY",
  },
];

export function getPlan(key: string): PlanDefinition | undefined {
  return PLANS.find((p) => p.key === key);
}

export function getPriceId(plan: PlanDefinition): string | undefined {
  return process.env[plan.priceIdEnvVar] || undefined;
}
