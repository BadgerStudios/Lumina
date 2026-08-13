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

## A day of the ad revenue pool, ad_feed policy v1 (55/45, 5% reserve, 14-day hold)
1. Advertisers prepaid campaigns (existing billing rail). Delivery writes realized spend into
   AdCampaignDaily per UTC day — the pool is what was actually DELIVERED, never the raw budget.
2. Each deduped video view also upserts VideoViewDay (same Redis dedupe decides both the public
   counter and the paid weight — one definition of "a view").
3. Worker sweep (economy/pools.ts), once per completed UTC day, ≤7-day lookback:
   pool = Σ AdCampaignDaily.spentCents; weights = Σ views per creator over APPROVED videos;
   ineligible creators (minor, banned, no age) removed BEFORE allocation so their views don't
   strand pool money.
4. allocatePool (largest-remainder, deterministic, property-tested) splits the WHOLE pool by
   views; integer residue is recorded on the PoolRun row, never minted or hidden.
5. Each creator's slice becomes an ordinary RevenueEvent (`adpool:<day>:<creator>`) and flows
   through the SAME funnel as tips: qualify → 55/45 split, 5% reserve carve → ledger →
   EarningItem with 14-day hold. A crashed sweep resumes through the idempotency keys; the
   PoolRun row (unique per product+day) stops a finished day from ever re-running.
6. A day with no ad spend ⇒ PoolRun EMPTY_POOL; ad spend but no qualified views ⇒
   NO_QUALIFIED_VIEWS. Both recorded, neither posts.

## A $5/mo membership, membership policy v1 (90/10, 7-day hold)
1. Creator publishes a tier (name, $1–$50/mo, active). PUT /economy/creator/tier, adult-gated.
2. Supporter subscribes → Stripe Checkout in SUBSCRIPTION mode; kind=membership + memberId +
   creatorId ride the subscription metadata, set by the server.
3. customer.subscription.* webhooks mirror state onto CreatorMembership (ACTIVE/PAST_DUE/
   CANCELED). The success URL grants nothing.
4. Every invoice.paid whose subscription maps to a membership becomes a RevenueEvent
   (`meminv:<invoiceId>`) → qualify → 90/10 split → ledger → EarningItem, 7-day hold. Renewal
   months post exactly like the first, each idempotent on its own invoice.
5. Cancel = cancel_at_period_end (supporter keeps the paid month); the deleted-subscription
   webhook flips the row when the period lapses. Price changes only affect NEW supporters —
   existing subscriptions own their price.

## Payouts
State machine and PayoutAccount exist; STRIPE_CONNECT_ENABLED=false gates the rail. Available
balances accrue and are honestly labeled in the Studio. Enabling = SETUP_ONCE.md.
