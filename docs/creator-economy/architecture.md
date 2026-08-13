# Creator Economy — Architecture (Phase 1–3 of the staged rollout)

## What is live

```
Tips (Stripe checkout)      Gifts (closed-loop coins)
        \                        /
         v                      v
      RevenueEvent (idempotent envelope, status machine)
                    |
            qualify()  — self-payment refused, minors never earn,
                    |    banned creators excluded, non-positive refused
                    v
      RevenuePolicy (versioned, effective-dated, basis points)
                    |
            splitRevenue()  — property-tested: creator+platform+reserve == gross
                    v
      Double-entry ledger (append-only, balanced-or-rejected, idempotent)
                    |
     CREATOR_PENDING --(hold window elapses, worker job)--> CREATOR_PAYABLE
                    |
      CreatorWallet read model (same tx) + EarningItem (the line a person can point at)
                    |
      Creator Studio (/studio) — ledger-backed numbers only
```

## Module map
- `modules/economy/ledger.ts` — chart of accounts, postTransaction, postReversal, derived balances,
  global invariant. No update/delete path exists for posted entries.
- `modules/economy/split.ts` — pure split + pool-allocation arithmetic (largest remainder,
  deterministic). Property tests in split.test.ts (thousands of randomized cases).
- `modules/economy/service.ts` — revenue events, qualification, policy lookup, posting, hold
  release, reversal.
- `modules/economy/routes.ts` — /api/economy: studio reads, tips, gifts, program status.
- `modules/economy/reconcile.ts` — §38 assertions run every 5 minutes by the worker.
- Billing webhook (`modules/billing/routes.ts`) dispatches `metadata.kind === "tip"`.
- Coins: the EXISTING CoinLedgerEntry store ledger funds gifts; COIN_DEFERRED mirrors the fiat
  liability on the money ledger.

## Deliberately NOT in this phase (staged per the master prompt §41)
Ad revenue pools, Premium attention allocation, memberships, storefront, affiliates, brand
marketplace, boosts-monetization interlock, copyright center, region table beyond the minor/adult
gates, Stripe Connect payouts (state machine present, rail gated off — SETUP_ONCE.md).
