import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, ConflictError } from "../../lib/errors.js";

/**
 * Double-entry ledger core — the single financial source of truth.
 *
 * ## The three rules everything here serves
 *
 * 1. **Balanced or rejected.** Every transaction's debits equal its credits, per currency, checked
 *    in code before the write and provable from rows afterwards. Money is created and destroyed
 *    nowhere in this system — it only moves between accounts.
 * 2. **Append-only.** There is no update or delete path for posted entries anywhere in the module.
 *    A mistake is corrected by a reversing transaction that leaves the original visible. This is
 *    what makes an audit answerable and what makes "an admin quietly edited a balance" impossible
 *    at the application layer.
 * 3. **Idempotent.** Every posting carries a caller-stable idempotency key with a unique index.
 *    Stripe redelivers webhooks, queues redeliver jobs, humans double-click; all of them land on
 *    the same key and post exactly once.
 *
 * Balances are DERIVED (sum of entries); CreatorWallet is a read model maintained inside the same
 * database transaction as its entries and re-proven against them by reconciliation — never trusted
 * against the ledger, only against latency.
 *
 * Money is BigInt minor units + ISO currency. No floats exist in this module or any caller.
 */

/** The chart of accounts. Deliberately an enum-like constant: an entry against an account that
 * isn't in the chart is a typo becoming a financial category, so account codes are closed. */
export const ACCOUNTS = {
  /** Asset — cash captured by the processor, not yet swept. */
  PROCESSOR_CLEARING: "PROCESSOR_CLEARING",
  /** Revenue — the platform's share of monetized transactions. */
  PLATFORM_REVENUE: "PLATFORM_REVENUE",
  /** Liability (control, by subjectUserId) — creator earnings inside the risk-hold window. */
  CREATOR_PENDING: "CREATOR_PENDING",
  /** Liability (control, by subjectUserId) — creator earnings withdrawable once payouts exist. */
  CREATOR_PAYABLE: "CREATOR_PAYABLE",
  /** Liability (control) — funds held back per policy against refunds/disputes. */
  CREATOR_RESERVE: "CREATOR_RESERVE",
  /** Liability — coin purchases not yet consumed: prepaid value owed to users as platform goods. */
  COIN_DEFERRED: "COIN_DEFERRED",
  /** Liability — refunds owed/processing. */
  REFUND_LIABILITY: "REFUND_LIABILITY",
  /** Asset (contra) — paid-out cash confirmed by the provider. */
  PAYOUTS_CLEARING: "PAYOUTS_CLEARING",
  /** Revenue — allocation rounding residue. Fractions of a cent go HERE, visibly, never invented
   * into anyone's balance and never silently dropped. */
  ROUNDING_RESIDUAL: "ROUNDING_RESIDUAL",
} as const;

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];
const ACCOUNT_SET = new Set<string>(Object.values(ACCOUNTS));

export interface EntryInput {
  account: AccountCode;
  direction: "DEBIT" | "CREDIT";
  amountMinor: bigint;
  currency: string;
  subjectUserId?: string | null;
  contentRef?: string | null;
}

export interface PostResult {
  transactionId: string;
  deduplicated: boolean;
}

function validate(entries: EntryInput[]): void {
  if (entries.length < 2) throw new BadRequestError("A ledger transaction needs at least two entries");
  const perCurrency = new Map<string, bigint>();
  for (const e of entries) {
    if (!ACCOUNT_SET.has(e.account)) throw new BadRequestError(`Unknown ledger account ${e.account}`);
    if (e.amountMinor <= 0n) throw new BadRequestError("Ledger entries must be positive; direction carries the sign");
    if (!/^[a-z]{3}$/.test(e.currency)) throw new BadRequestError("Currency must be a 3-letter ISO code");
    const delta = e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor;
    perCurrency.set(e.currency, (perCurrency.get(e.currency) ?? 0n) + delta);
  }
  for (const [currency, sum] of perCurrency) {
    if (sum !== 0n) throw new BadRequestError(`Unbalanced ledger transaction in ${currency}: ${sum}`);
  }
}

/** How one entry moves the wallet read model. Only control accounts touch wallets. */
function walletDelta(e: EntryInput): { field: "pendingMinor" | "availableMinor" | "reservedMinor" | "paidMinor"; delta: bigint } | null {
  if (!e.subjectUserId) return null;
  // Liabilities grow on CREDIT. A credit to CREATOR_PENDING is money now owed to the creator.
  const sign = e.direction === "CREDIT" ? 1n : -1n;
  switch (e.account) {
    case ACCOUNTS.CREATOR_PENDING:
      return { field: "pendingMinor", delta: sign * e.amountMinor };
    case ACCOUNTS.CREATOR_PAYABLE:
      return { field: "availableMinor", delta: sign * e.amountMinor };
    case ACCOUNTS.CREATOR_RESERVE:
      return { field: "reservedMinor", delta: sign * e.amountMinor };
    case ACCOUNTS.PAYOUTS_CLEARING:
      // Paid-lifetime grows when we debit payable and debit... tracked on the payout posting
      // explicitly instead, to keep this mapping single-purpose.
      return null;
    default:
      return null;
  }
}

/**
 * Post a balanced transaction atomically, updating wallet read models in the same transaction.
 * Replays of the same idempotencyKey return the original posting and write nothing.
 */
export async function postTransaction(params: {
  kind: string;
  idempotencyKey: string;
  occurredAt?: Date;
  externalRef?: string | null;
  metadata?: Prisma.InputJsonValue;
  entries: EntryInput[];
  /** Extra wallet effect for lifetime-paid tracking on payout postings. */
  paidDelta?: { userId: string; amountMinor: bigint };
}): Promise<PostResult> {
  validate(params.entries);

  try {
    const txId = await prisma.$transaction(async (tx) => {
      const created = await tx.ledgerTransaction.create({
        data: {
          kind: params.kind,
          idempotencyKey: params.idempotencyKey,
          externalRef: params.externalRef ?? null,
          occurredAt: params.occurredAt ?? new Date(),
          metadata: params.metadata,
          entries: {
            create: params.entries.map((e) => ({
              accountCode: e.account,
              direction: e.direction,
              amountMinor: e.amountMinor,
              currency: e.currency,
              subjectUserId: e.subjectUserId ?? null,
              contentRef: e.contentRef ?? null,
            })),
          },
        },
      });

      // Wallet read models, same transaction: the wallet can lag reality only if this whole
      // posting rolled back, in which case there is no reality to lag.
      const deltas = new Map<string, { pendingMinor: bigint; availableMinor: bigint; reservedMinor: bigint; paidMinor: bigint }>();
      for (const e of params.entries) {
        const d = walletDelta(e);
        if (!d) continue;
        const agg = deltas.get(e.subjectUserId!) ?? { pendingMinor: 0n, availableMinor: 0n, reservedMinor: 0n, paidMinor: 0n };
        agg[d.field] += d.delta;
        deltas.set(e.subjectUserId!, agg);
      }
      if (params.paidDelta) {
        const agg = deltas.get(params.paidDelta.userId) ?? { pendingMinor: 0n, availableMinor: 0n, reservedMinor: 0n, paidMinor: 0n };
        agg.paidMinor += params.paidDelta.amountMinor;
        deltas.set(params.paidDelta.userId, agg);
      }
      for (const [userId, d] of deltas) {
        await tx.creatorWallet.upsert({
          where: { userId },
          create: {
            userId,
            pendingMinor: d.pendingMinor,
            availableMinor: d.availableMinor,
            reservedMinor: d.reservedMinor,
            paidMinor: d.paidMinor,
          },
          update: {
            pendingMinor: { increment: d.pendingMinor },
            availableMinor: { increment: d.availableMinor },
            reservedMinor: { increment: d.reservedMinor },
            paidMinor: { increment: d.paidMinor },
          },
        });
      }
      return created.id;
    });
    return { transactionId: txId, deduplicated: false };
  } catch (err) {
    // Unique violation on idempotencyKey = this posting already happened. Return it, change nothing.
    const existing = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { transactionId: existing.id, deduplicated: true };
    throw err;
  }
}

/** Reversal = the mirror transaction, linked by metadata. The original stays forever. */
export async function postReversal(originalId: string, reason: string): Promise<PostResult> {
  const original = await prisma.ledgerTransaction.findUnique({
    where: { id: originalId },
    include: { entries: true },
  });
  if (!original) throw new ConflictError("Original transaction not found");
  return postTransaction({
    kind: `${original.kind}.reversal`,
    idempotencyKey: `reversal:${originalId}`,
    metadata: { reverses: originalId, reason },
    entries: original.entries.map((e) => ({
      account: e.accountCode as AccountCode,
      direction: e.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      amountMinor: e.amountMinor,
      currency: e.currency,
      subjectUserId: e.subjectUserId,
      contentRef: e.contentRef,
    })),
  });
}

/** Derive an account balance straight from entries — reconciliation's view of the truth. */
export async function deriveBalance(account: AccountCode, subjectUserId?: string): Promise<bigint> {
  const entries = await prisma.ledgerEntry.groupBy({
    by: ["direction"],
    where: { accountCode: account, ...(subjectUserId ? { subjectUserId } : {}) },
    _sum: { amountMinor: true },
  });
  let credit = 0n, debit = 0n;
  for (const e of entries) {
    if (e.direction === "CREDIT") credit = e._sum.amountMinor ?? 0n;
    else debit = e._sum.amountMinor ?? 0n;
  }
  // Liability/control convention: credit-positive.
  return credit - debit;
}

/**
 * The global invariant, checkable at any moment: across the whole ledger, debits == credits.
 * Run by reconciliation and by tests; a nonzero answer is a stop-the-world defect.
 */
export async function globalImbalance(): Promise<bigint> {
  const sums = await prisma.ledgerEntry.groupBy({ by: ["direction"], _sum: { amountMinor: true } });
  let credit = 0n, debit = 0n;
  for (const s of sums) {
    if (s.direction === "CREDIT") credit = s._sum.amountMinor ?? 0n;
    else debit = s._sum.amountMinor ?? 0n;
  }
  return debit - credit;
}
