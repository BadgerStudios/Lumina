# Money Flow

## A $5.00 tip (500 minor units), tip policy v1 (95/5, 7-day hold)
1. Viewer → Stripe Checkout (metadata: kind=tip, tipperId, creatorId). Browser asserts nothing.
2. Webhook (signature-verified, replay-safe) → RevenueEvent `tip:payment_succeeded`,
   idempotency `tip:<sessionId>`.
3. qualify(): tipper ≠ creator, creator adult+unbanned. Fail ⇒ EXCLUDED with reason, no ledger.
4. Ledger (balanced): DEBIT PROCESSOR_CLEARING 500 / CREDIT PLATFORM_REVENUE 25 /
   CREDIT CREATOR_PENDING(creator) 475.
5. EarningItem PENDING, availableAt = +7d. Wallet read model updated same tx.
6. Worker releases at maturity: DEBIT PENDING / CREDIT PAYABLE (idempotent `release:<itemId>`).
7. Refund ⇒ postReversal (mirror tx) + EarningItem REVERSED. Originals never edited.

## A 250-coin gift (Aurora), gift policy v1 (80/20)
1. Coin purchase (already live via store): Stripe → CoinLedgerEntry credit; fiat counterpart is
   COIN_DEFERRED liability.
2. Send: one DB tx = balance check + GiftSend row + CoinLedgerEntry −250 (`gift:<sendId>`), so a
   double-tap can't double-spend.
3. RevenueEvent gift.sent, gross 250¢ (1 spark = $0.01): DEBIT COIN_DEFERRED 250 /
   CREDIT PLATFORM_REVENUE 50 / CREDIT CREATOR_PENDING 200.
4. Same hold → available → (payout, when rail enabled).

## Payouts
State machine and PayoutAccount exist; STRIPE_CONNECT_ENABLED=false gates the rail. Available
balances accrue and are honestly labeled in the Studio. Enabling = SETUP_ONCE.md.
