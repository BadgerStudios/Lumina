import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * The store economy.
 *
 * ## Balance is derived, never stored
 *
 * A user's balance is `SUM(delta)` over their ledger entries. The obvious alternative — a
 * `User.coinBalance` column — loses money under concurrency: two simultaneous purchases both read
 * 500, both write 400, and one item is free. Deriving it makes that impossible to express, and
 * makes every balance reconstructible from an append-only history, which is what you want the first
 * time somebody disputes a charge.
 *
 * The cost is an aggregate per read. That is nothing at this size, and when it stops being nothing
 * the fix is a cached projection alongside the ledger — not a mutable column.
 */

/**
 * Serialize every coin-balance mutation for ONE user, held until the surrounding transaction ends.
 *
 * Deriving the balance as SUM(delta) stops a stored column drifting, but on its own it does NOT stop
 * two concurrent spends of DIFFERENT items (or a store purchase racing a gift send) from each reading
 * the same pre-debit balance under READ COMMITTED and both committing — the per-item unique constraint
 * only blocks buying the same item twice. Taking a per-user advisory xact lock at the top of each
 * spending transaction makes them actually serial: the second transaction blocks until the first
 * commits, then re-derives a balance that already reflects the first debit. Every path that debits
 * coins (store purchase, gift send) must take this lock, or the ones that don't can still race the
 * ones that do.
 */
export async function lockUserCoins(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}

export async function getBalance(userId: string, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const result = await tx.coinLedgerEntry.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return result._sum.delta ?? 0;
}

/**
 * Credits coins. `refId` is the idempotency key.
 *
 * Stripe retries a webhook on any non-2xx response, so the same `checkout.session.completed` can
 * legitimately arrive several times. The unique index on `refId` turns a double-credit into a
 * constraint violation we swallow, rather than free money.
 */
export async function credit(params: {
  userId: string;
  amount: number;
  reason: "PURCHASE_BUNDLE" | "PROMO_GRANT" | "ADMIN_ADJUST" | "REFUND";
  refId?: string;
  note?: string;
}): Promise<{ credited: boolean; balance: number }> {
  if (params.amount <= 0) throw new BadRequestError("Credit amount must be positive");

  try {
    await prisma.coinLedgerEntry.create({
      data: {
        userId: params.userId,
        delta: params.amount,
        reason: params.reason,
        refId: params.refId ?? null,
        note: params.note ?? null,
      },
    });
  } catch (error) {
    // P2002 = unique violation on refId: this exact payment was already credited. Not an error —
    // it is the idempotency guarantee doing its job — so report success without crediting again.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { credited: false, balance: await getBalance(params.userId) };
    }
    throw error;
  }
  return { credited: true, balance: await getBalance(params.userId) };
}

/**
 * Buys an item.
 *
 * The balance check and the debit are in one transaction, and the `@@unique([userId, itemId])` on
 * StoreGrant is what makes a double-submitted purchase safe: the second insert violates the
 * constraint and the whole transaction rolls back, so the coins are never taken for an item the
 * user already owns.
 */
export async function purchase(userId: string, itemId: string) {
  return prisma.$transaction(async (tx) => {
    // First thing in the tx: serialize this user's spends so a concurrent purchase of a different
    // item (or a gift send) can't read the same balance and overspend into the negative.
    await lockUserCoins(tx, userId);

    const item = await tx.storeItem.findUnique({ where: { id: itemId } });
    if (!item || !item.active) throw new BadRequestError("That item isn't available");

    const owned = await tx.storeGrant.findUnique({
      where: { userId_itemId: { userId, itemId } },
    });
    if (owned) throw new BadRequestError("You already own this");

    const balance = await getBalance(userId, tx);
    if (balance < item.priceCoins) {
      throw new BadRequestError(
        `Not enough sparks — this costs ${item.priceCoins} and you have ${balance}`,
      );
    }

    await tx.coinLedgerEntry.create({
      data: {
        userId,
        delta: -item.priceCoins,
        reason: "SPEND_STORE",
        note: item.sku,
      },
    });
    const grant = await tx.storeGrant.create({ data: { userId, itemId } });

    return { grant, item, balance: balance - item.priceCoins };
  });
}

/** The catalogue, with ownership resolved for this viewer so the UI can render owned vs buyable in
 * one round trip rather than a request per card. */
export async function catalogue(userId: string) {
  const [items, grants] = await Promise.all([
    prisma.storeItem.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.storeGrant.findMany({ where: { userId }, select: { itemId: true } }),
  ]);
  const owned = new Set(grants.map((g) => g.itemId));

  return items.map((i) => ({
    id: i.id,
    sku: i.sku,
    kind: i.kind,
    name: i.name,
    description: i.description,
    payload: i.payload,
    priceCoins: i.priceCoins,
    owned: owned.has(i.id),
  }));
}

/** Everything this user owns — drives which themes/badges the client is allowed to apply. */
export async function inventory(userId: string) {
  const grants = await prisma.storeGrant.findMany({
    where: { userId },
    include: { item: true },
    orderBy: { acquiredAt: "desc" },
  });
  return grants.map((g) => ({
    sku: g.item.sku,
    kind: g.item.kind,
    name: g.item.name,
    payload: g.item.payload,
    acquiredAt: g.acquiredAt,
  }));
}

/**
 * Coin bundles.
 *
 * Priced so the fixed card fee stops dominating. At Stripe's ~2.9% + $0.30, a $1.99 charge loses
 * about 18% to fees; a $9.99 charge loses about 6%. The smallest bundle is deliberately not the
 * best value — it exists so the entry price is low, not so it is the one people buy.
 *
 * `priceId` comes from the environment because Stripe price objects are created in the dashboard
 * and differ between test and live mode; hard-coding them guarantees a production outage the first
 * time keys are rotated.
 */
export interface CoinBundle {
  key: string;
  coins: number;
  label: string;
  priceEnvVar: string;
}

export const COIN_BUNDLES: CoinBundle[] = [
  { key: "small", coins: 500, label: "500 sparks", priceEnvVar: "STRIPE_PRICE_SPARKS_500" },
  { key: "medium", coins: 1200, label: "1,200 sparks", priceEnvVar: "STRIPE_PRICE_SPARKS_1200" },
  { key: "large", coins: 2600, label: "2,600 sparks", priceEnvVar: "STRIPE_PRICE_SPARKS_2600" },
];

export function bundleByKey(key: string): CoinBundle | undefined {
  return COIN_BUNDLES.find((b) => b.key === key);
}
