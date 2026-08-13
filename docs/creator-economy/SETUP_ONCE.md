# One-Time Operator Setup (everything code cannot self-provision)

Payments (to open real payouts):
1. Enable Stripe Connect on the existing Stripe account (Dashboard → Connect). Express accounts.
2. Accept Stripe's Connected Account agreement; choose loss liability per Stripe's current terms.
3. Confirm the existing webhook endpoint also subscribes to: account.updated, transfer.*,
   payout.paid, payout.failed.
4. Set STRIPE_CONNECT_ENABLED=true in .env and redeploy.
5. Tax: in Stripe Dashboard, enable Connect tax reporting (Stripe generates/e-delivers 1099s for
   US-based Express accounts under current guidance — verify at enable time; see
   compliance-source-register.md).

Not needed: creator approval queues, earnings calculation, payout scheduling, KYC review —
all automated or provider-hosted by design (autonomy contract §1).
