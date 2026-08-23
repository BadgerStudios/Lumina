import { prisma } from "../../db/prisma.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { ACCOUNTS, postTransaction, postReversal } from "./ledger.js";
import { splitRevenue } from "./split.js";
import { pushInboxNotification } from "../inbox/service.js";
import { isUserBanned } from "../bans/service.js";

/**
 * Revenue engine: events in, policy applied, ledger posted, earnings tracked.
 *
 * The flow every monetized product uses, with no exceptions and no shortcuts:
 *
 *   revenue event (idempotent) → qualification → policy lookup (versioned, effective-dated)
 *     → splitRevenue (exact, property-tested) → ledger posting (balanced, idempotent)
 *     → EarningItem (creator-visible line with a hold window)
 *
 * A product that wants to pay creators has exactly one entry point: recordRevenueEvent + a
 * poster. Nothing else in the codebase may touch creator balances — that single funnel is what
 * makes the automation auditable and the fraud story enforceable.
 */

export const PRODUCTS = {
  TIP: "tip",
  GIFT: "gift",
  AD_FEED: "ad_feed",
  PREMIUM_POOL: "premium_pool",
  MEMBERSHIP: "membership",
} as const;
export type Product = (typeof PRODUCTS)[keyof typeof PRODUCTS];

/** One coin's fiat value in USD minor units. Coins are sold at this rate (see store bundles) and
 * gift earnings convert at it — one number, one place, versioned by policy when it changes. */
export const COIN_VALUE_MINOR = 1n; // 1 spark = $0.01

/** Launch-default splits, seeded as VERSIONED ROWS at boot (not consulted directly at runtime) —
 * the running system reads the table, so changing economics is an audited data change with an
 * effective date, never a deploy. */
const DEFAULT_POLICIES: { product: string; creatorBps: number; platformBps: number; holdDays: number; reserveBps: number }[] = [
  { product: PRODUCTS.TIP, creatorBps: 9500, platformBps: 500, holdDays: 7, reserveBps: 0 },
  { product: PRODUCTS.GIFT, creatorBps: 8000, platformBps: 2000, holdDays: 7, reserveBps: 0 },
  { product: PRODUCTS.AD_FEED, creatorBps: 5500, platformBps: 4500, holdDays: 14, reserveBps: 500 },
  { product: PRODUCTS.PREMIUM_POOL, creatorBps: 5500, platformBps: 4500, holdDays: 14, reserveBps: 0 },
  { product: PRODUCTS.MEMBERSHIP, creatorBps: 9000, platformBps: 1000, holdDays: 7, reserveBps: 0 },
];

/** Human wording for the earnings inbox line, per product. */
const EARNING_PREVIEW: Record<string, string> = {
  [PRODUCTS.TIP]: "You earned from a tip",
  [PRODUCTS.GIFT]: "You earned from a gift",
  [PRODUCTS.AD_FEED]: "You earned from the daily ad revenue pool",
  [PRODUCTS.PREMIUM_POOL]: "You earned from the Premium pool",
  [PRODUCTS.MEMBERSHIP]: "You earned from a supporter membership",
};

export async function seedPolicies(): Promise<void> {
  for (const p of DEFAULT_POLICIES) {
    const existing = await prisma.revenuePolicy.findFirst({ where: { product: p.product } });
    if (!existing) {
      await prisma.revenuePolicy.create({
        data: { ...p, version: 1, effectiveFrom: new Date(0), notes: "launch default" },
      });
    }
  }
}

export async function activePolicy(product: string, at = new Date()) {
  const policy = await prisma.revenuePolicy.findFirst({
    where: {
      product,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { version: "desc" },
  });
  if (!policy) throw new ConflictError(`No active revenue policy for ${product}`);
  return policy;
}

/**
 * Record a revenue event. Idempotent on the caller's key; a replay returns the existing event.
 * Recording is separate from posting so qualification can sit between them.
 */
export async function recordRevenueEvent(params: {
  eventType: string;
  idempotencyKey: string;
  source: string;
  occurredAt?: Date;
  currency: string;
  grossMinor: bigint;
  userId?: string | null;
  creatorId?: string | null;
  contentRef?: string | null;
  externalRef?: string | null;
  /** Stripe PaymentIntent id, for fiat sources — the key a refund/dispute webhook can find this by. */
  paymentIntentId?: string | null;
  riskContext?: Record<string, unknown>;
}) {
  try {
    return await prisma.revenueEvent.create({
      data: {
        eventType: params.eventType,
        idempotencyKey: params.idempotencyKey,
        source: params.source,
        occurredAt: params.occurredAt ?? new Date(),
        currency: params.currency,
        grossMinor: params.grossMinor,
        userId: params.userId ?? null,
        creatorId: params.creatorId ?? null,
        contentRef: params.contentRef ?? null,
        externalRef: params.externalRef ?? null,
        paymentIntentId: params.paymentIntentId ?? null,
        riskContext: params.riskContext as never,
      },
    });
  } catch {
    const existing = await prisma.revenueEvent.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
    if (existing) return existing;
    throw new ConflictError("Could not record revenue event");
  }
}

/**
 * Baseline qualification — the checks every event must clear before money moves. The fuller risk
 * engine layers ON TOP of this by excluding events; nothing may skip it.
 */
async function qualify(eventId: string): Promise<{ ok: boolean; reason?: string }> {
  const event = await prisma.revenueEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.creatorId) return { ok: false, reason: "no-creator" };
  // Self-payment is the simplest laundering shape: money in via card, out via payout, dressed as
  // income. Refused at the root rather than in each product.
  if (event.userId && event.userId === event.creatorId) return { ok: false, reason: "self-payment" };
  const creator = await prisma.user.findUnique({
    where: { id: event.creatorId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  if (!creator) return { ok: false, reason: "creator-missing" };
  // Minors do not accrue monetized earnings, full stop — §27's default posture and this
  // platform's existing minor regime agree.
  if (creator.isMinor || creator.ageRecordedAt === null) return { ok: false, reason: "creator-not-adult" };
  // Platform bans are rows, not a column — the same check every authenticated request uses.
  if (await isUserBanned(event.creatorId)) return { ok: false, reason: "creator-banned" };
  if (event.grossMinor <= 0n) return { ok: false, reason: "non-positive" };
  return { ok: true };
}

/**
 * Qualify and post one event to the ledger under the active policy. The complete money movement
 * for a direct-attribution product (tips, gifts): clearing in, platform share to revenue, creator
 * share to PENDING with a hold window.
 */
export async function qualifyAndPost(eventId: string, options?: { fundingAccount?: "PROCESSOR_CLEARING" | "COIN_DEFERRED" }) {
  const event = await prisma.revenueEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (event.status === "POSTED") return event;

  const verdict = await qualify(eventId);
  if (!verdict.ok) {
    return prisma.revenueEvent.update({
      where: { id: eventId },
      data: { status: "EXCLUDED", excludedReason: verdict.reason },
    });
  }

  const product = event.eventType.split(".")[0]!;
  const policy = await activePolicy(product, event.occurredAt);
  const split = splitRevenue(event.grossMinor, {
    creatorBps: policy.creatorBps,
    platformBps: policy.platformBps,
    reserveBps: policy.reserveBps,
  });

  const funding = options?.fundingAccount ?? "PROCESSOR_CLEARING";
  const posting = await postTransaction({
    kind: `revenue.${product}`,
    idempotencyKey: `revevent:${event.id}`,
    occurredAt: event.occurredAt,
    metadata: { revenueEventId: event.id, policyVersion: policy.version },
    entries: [
      // Where the money came from: card money sits in processor clearing; gift money consumes
      // coin liability the purchase already funded.
      { account: ACCOUNTS[funding], direction: "DEBIT", amountMinor: event.grossMinor, currency: event.currency },
      ...(split.platformMinor > 0n
        ? [{ account: ACCOUNTS.PLATFORM_REVENUE, direction: "CREDIT" as const, amountMinor: split.platformMinor, currency: event.currency }]
        : []),
      ...(split.creatorMinor > 0n
        ? [{ account: ACCOUNTS.CREATOR_PENDING, direction: "CREDIT" as const, amountMinor: split.creatorMinor, currency: event.currency, subjectUserId: event.creatorId!, contentRef: event.contentRef }]
        : []),
      ...(split.reserveMinor > 0n
        ? [{ account: ACCOUNTS.CREATOR_RESERVE, direction: "CREDIT" as const, amountMinor: split.reserveMinor, currency: event.currency, subjectUserId: event.creatorId! }]
        : []),
    ],
  });

  const availableAt = new Date(event.occurredAt.getTime() + policy.holdDays * 24 * 60 * 60 * 1000);
  if (split.creatorMinor > 0n) {
    await prisma.earningItem.upsert({
      where: { revenueEventId: event.id },
      create: {
        creatorId: event.creatorId!,
        revenueEventId: event.id,
        product,
        amountMinor: split.creatorMinor,
        currency: event.currency,
        availableAt,
        policyVersion: policy.version,
      },
      update: {},
    });
    // The comeback trigger that matters most to a creator: money.
    await pushInboxNotification({
      userId: event.creatorId!,
      kind: "EARNING",
      bundleKey: `EARNING:${new Date().toISOString().slice(0, 10)}`,
      preview: EARNING_PREVIEW[product] ?? `You have new earnings`,
    }).catch(() => undefined);
  }

  return prisma.revenueEvent.update({
    where: { id: eventId },
    data: { status: "POSTED", ledgerTxId: posting.transactionId, policyVersion: policy.version },
  });
}

/**
 * The hold-window release: PENDING earnings whose window elapsed become AVAILABLE, moved by a
 * balanced ledger transaction per item (idempotent on the item id, so a crashed sweep re-runs
 * safely). Runs from the worker on a schedule; no human ever "approves" it — §1.1.
 */
export async function releaseMaturedEarnings(limit = 200): Promise<number> {
  const due = await prisma.earningItem.findMany({
    where: { status: "PENDING", availableAt: { lte: new Date() } },
    take: limit,
  });
  let released = 0;
  for (const item of due) {
    // Claim the row (PENDING→AVAILABLE) BEFORE posting. This conditional update serializes against
    // reverseRevenueEvent's identical PENDING claim through the row lock, so a maturity release and
    // a refund reversal can never both post to the ledger for one earning. Losing the claim means a
    // reversal already took it — skip without posting.
    const claim = await prisma.earningItem.updateMany({
      where: { id: item.id, status: "PENDING" },
      data: { status: "AVAILABLE" },
    });
    if (claim.count === 0) continue;
    try {
      await postTransaction({
        kind: "earning.release",
        idempotencyKey: `release:${item.id}`,
        metadata: { earningItemId: item.id },
        entries: [
          { account: ACCOUNTS.CREATOR_PENDING, direction: "DEBIT", amountMinor: item.amountMinor, currency: item.currency, subjectUserId: item.creatorId },
          { account: ACCOUNTS.CREATOR_PAYABLE, direction: "CREDIT", amountMinor: item.amountMinor, currency: item.currency, subjectUserId: item.creatorId },
        ],
      });
    } catch (err) {
      // Post failed after we claimed — return the row to PENDING so the next sweep retries, rather
      // than leaving it AVAILABLE with no release ever posted (money stranded in pending).
      await prisma.earningItem
        .updateMany({ where: { id: item.id, status: "AVAILABLE" }, data: { status: "PENDING" } })
        .catch(() => undefined);
      throw err;
    }
    released++;
  }
  return released;
}

/** Outcome of attempting to reverse one revenue event. Never a throw for the expected refund
 * shapes — the webhook aggregates these and logs the ones a human must finish by hand. */
export type ReverseOutcome =
  | { status: "reversed"; eventId: string; amountMinor: bigint }
  | { status: "already-reversed"; eventId: string }
  | { status: "not-posted"; eventId: string }
  | { status: "no-creator-earning"; eventId: string }
  | { status: "requires-manual"; eventId: string; earningStatus: string; amountMinor: bigint };

/**
 * Refund/dispute path: reverse the original posting and mark the creator earning REVERSED.
 *
 * LEDGER SAFETY — this is the whole reason the function is shaped like this. The original posting
 * credited CREATOR_PENDING. `postReversal` mirrors that posting exactly (flips every entry), so it
 * is only balanced while the creator share is STILL PENDING. Once the hold window elapses,
 * `releaseMaturedEarnings` has already moved that money PENDING→PAYABLE (and a payout may have
 * moved it again). Mirroring the original posting then would DEBIT CREATOR_PENDING it no longer
 * holds, driving that account negative and tripping the financial assertions.
 *
 * So: reverse cleanly while PENDING; for a matured/paid earning, DO NOTHING to the ledger and
 * report `requires-manual` — clawing back money a creator was already paid is a business decision,
 * not something a webhook may do silently. Platform-only events (no creator share) reverse safely.
 * Idempotent: the ledger post is keyed `reversal:<txId>`, and a re-run finds the earning already
 * REVERSED and reports `already-reversed`.
 */
export async function reverseRevenueEvent(eventId: string, reason: string): Promise<ReverseOutcome> {
  const event = await prisma.revenueEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.ledgerTxId || event.status !== "POSTED") return { status: "not-posted", eventId };

  const earning = await prisma.earningItem.findUnique({ where: { revenueEventId: eventId } });

  // Platform-only revenue (no creator share) — safe to mirror, nothing matures.
  if (!earning) {
    await postReversal(event.ledgerTxId, reason);
    return { status: "no-creator-earning", eventId };
  }
  if (earning.status === "REVERSED") {
    // Self-heal the crash window: if the process died AFTER the claim (PENDING→REVERSED) committed but
    // BEFORE postReversal, the earning reads REVERSED while the ledger reversal was never posted — and
    // nothing else would ever re-post it (the sweep only touches PENDING). postReversal is idempotent
    // (keyed `reversal:<txId>`), so this re-posts only if genuinely missing and is a no-op otherwise.
    await postReversal(event.ledgerTxId, reason);
    return { status: "already-reversed", eventId };
  }
  // Matured or paid out — mirroring would corrupt the ledger. Hands off; a human decides clawback.
  if (earning.status !== "PENDING") {
    return { status: "requires-manual", eventId, earningStatus: earning.status, amountMinor: earning.amountMinor };
  }

  // Claim the still-pending earning BEFORE touching the ledger. This conditional update serializes,
  // via the row lock, against releaseMaturedEarnings' identical `status: "PENDING"` claim: exactly
  // one of {reverse, release} can move the row out of PENDING, so the reversal posting and the
  // maturity release can never both fire for the same earning (which would double-debit
  // CREATOR_PENDING). If we lose the claim, the row already moved — re-read and report precisely.
  const claim = await prisma.earningItem.updateMany({
    where: { revenueEventId: eventId, status: "PENDING" },
    data: { status: "REVERSED" },
  });
  if (claim.count === 1) {
    try {
      await postReversal(event.ledgerTxId, reason);
    } catch (err) {
      // Post failed after we claimed — roll the claim back to PENDING so a webhook redelivery
      // retries cleanly, rather than leaving the row REVERSED with the ledger never reversed.
      await prisma.earningItem
        .updateMany({ where: { revenueEventId: eventId, status: "REVERSED" }, data: { status: "PENDING" } })
        .catch(() => undefined);
      throw err;
    }
    return { status: "reversed", eventId, amountMinor: earning.amountMinor };
  }
  const current = await prisma.earningItem.findUnique({ where: { revenueEventId: eventId } });
  if (current?.status === "REVERSED") return { status: "already-reversed", eventId };
  return { status: "requires-manual", eventId, earningStatus: current?.status ?? "UNKNOWN", amountMinor: earning.amountMinor };
}

/**
 * Reverse every posted creator earning funded by one Stripe PaymentIntent. This is the entry point
 * a `charge.refunded` / `charge.dispute.created` webhook calls — those payloads carry the
 * payment_intent but not the checkout-session / invoice id the event was keyed on, which is exactly
 * why `RevenueEvent.paymentIntentId` exists. Returns the per-event outcomes so the caller can log
 * the `requires-manual` ones; never throws for the matured case.
 */
export async function reverseEarningsForPaymentIntent(paymentIntentId: string, reason: string): Promise<ReverseOutcome[]> {
  if (!paymentIntentId) return [];
  const events = await prisma.revenueEvent.findMany({
    where: { paymentIntentId, status: "POSTED" },
    select: { id: true },
  });
  const outcomes: ReverseOutcome[] = [];
  for (const e of events) {
    outcomes.push(await reverseRevenueEvent(e.id, reason));
  }
  return outcomes;
}
