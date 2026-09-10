/**
 * What makes a Stripe checkout session a coin top-up, and for how many sparks.
 *
 * One definition, used by the credit path and by the refund/dispute reversal path. They
 * parsed this independently before, which is a quiet hazard rather than a tidiness point:
 * a disagreement between them fails in one direction only — sparks credited on payment and
 * not taken back when the money goes back.
 *
 * Everything here comes from metadata this server set when it created the session, never
 * from anything the customer can influence.
 */
export interface CoinTopUp {
  userId: string;
  coins: number;
  bundleKey?: string;
}

/**
 * Returns null for anything that is not a coin top-up — subscriptions, tips and ad campaigns
 * all arrive through the same events.
 *
 * `coins` must be a positive, whole, safe integer. A fractional value passed the old
 * `Number.isFinite(coins) && coins > 0` check and went into an integer column; a value beyond
 * MAX_SAFE_INTEGER would have arrived already rounded and unreversible.
 */
export function coinTopUpFromMetadata(metadata: Record<string, string> | null | undefined): CoinTopUp | null {
  if (!metadata) return null;
  const userId = metadata.userId;
  if (typeof userId !== "string" || userId.length === 0) return null;

  const raw = metadata.coins;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const coins = Number(raw);
  if (!Number.isSafeInteger(coins) || coins <= 0) return null;

  const bundleKey = metadata.bundleKey;
  return { userId, coins, ...(bundleKey ? { bundleKey } : {}) };
}
