import { prisma } from "../../db/prisma.js";
import { ACCOUNTS, deriveBalance, globalImbalance } from "./ledger.js";

/**
 * The automated financial assertions — §38 running in production, every few minutes.
 *
 * Reconciliation READS and REPORTS. It never fixes a discrepancy by writing balances: a wallet
 * that disagrees with its ledger derivation is evidence of a defect, and papering over evidence
 * is how a books-cooking bug survives to payday. Discrepancies quarantine themselves by simply
 * being logged loudly while payouts stay gated.
 */
export async function runFinancialAssertions(): Promise<string[]> {
  const problems: string[] = [];

  const imbalance = await globalImbalance();
  if (imbalance !== 0n) problems.push(`GLOBAL LEDGER IMBALANCE: debits-credits=${imbalance}`);

  // Every wallet read model must equal its ledger derivation, field by field.
  const wallets = await prisma.creatorWallet.findMany();
  for (const w of wallets) {
    const pending = await deriveBalance(ACCOUNTS.CREATOR_PENDING, w.userId);
    const available = await deriveBalance(ACCOUNTS.CREATOR_PAYABLE, w.userId);
    const reserved = await deriveBalance(ACCOUNTS.CREATOR_RESERVE, w.userId);
    if (pending !== w.pendingMinor) problems.push(`wallet drift ${w.userId} pending ${w.pendingMinor}!=${pending}`);
    if (available !== w.availableMinor) problems.push(`wallet drift ${w.userId} available ${w.availableMinor}!=${available}`);
    if (reserved !== w.reservedMinor) problems.push(`wallet drift ${w.userId} reserved ${w.reservedMinor}!=${reserved}`);
    if (w.availableMinor < 0n) problems.push(`NEGATIVE AVAILABLE for ${w.userId}: ${w.availableMinor}`);
    // pending and reserved are liabilities exactly like available — negative is impossible under
    // sane accounting either way. Only checking availableMinor meant a negative pending/reserved
    // that the ledger and wallet happened to still agree on (so the drift check above wouldn't
    // catch it either) passed silently.
    if (w.pendingMinor < 0n) problems.push(`NEGATIVE PENDING for ${w.userId}: ${w.pendingMinor}`);
    if (w.reservedMinor < 0n) problems.push(`NEGATIVE RESERVED for ${w.userId}: ${w.reservedMinor}`);
  }

  // No coin wallet below zero — the closed loop stays closed.
  const coinBalances = await prisma.coinLedgerEntry.groupBy({ by: ["userId"], _sum: { delta: true } });
  for (const c of coinBalances) {
    if ((c._sum.delta ?? 0) < 0) problems.push(`NEGATIVE COIN BALANCE for ${c.userId}: ${c._sum.delta}`);
  }

  // Every POSTED revenue event points at a ledger transaction that exists.
  const orphaned = await prisma.revenueEvent.count({ where: { status: "POSTED", ledgerTxId: null } });
  if (orphaned > 0) problems.push(`${orphaned} POSTED revenue event(s) with no ledger transaction`);

  return problems;
}
