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
    await postTransaction({
      kind: "earning.release",
      idempotencyKey: `release:${item.id}`,
      metadata: { earningItemId: item.id },
      entries: [
        { account: ACCOUNTS.CREATOR_PENDING, direction: "DEBIT", amountMinor: item.amountMinor, currency: item.currency, subjectUserId: item.creatorId },
        { account: ACCOUNTS.CREATOR_PAYABLE, direction: "CREDIT", amountMinor: item.amountMinor, currency: item.currency, subjectUserId: item.creatorId },
      ],
    });
    await prisma.earningItem.update({ where: { id: item.id }, data: { status: "AVAILABLE" } });
    released++;
  }
  return released;
}

/** Refund/dispute path: reverse the original posting and mark the earning REVERSED. History is
 * untouched; the reversal is a new, visible transaction. */
export async function reverseRevenueEvent(eventId: string, reason: string) {
  const event = await prisma.revenueEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (!event.ledgerTxId) throw new BadRequestError("Event was never posted");
  await postReversal(event.ledgerTxId, reason);
  await prisma.earningItem.updateMany({
    where: { revenueEventId: eventId, status: { in: ["PENDING", "AVAILABLE"] } },
    data: { status: "REVERSED" },
  });
}
