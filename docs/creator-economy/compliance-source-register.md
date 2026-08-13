# Compliance Source Register

| Assumption | Source to verify at enable-time | Feature gated on it | Verified |
|---|---|---|---|
| Stripe Connect Express handles KYC + hosted onboarding | stripe.com/docs/connect (current) | payouts | ☐ operator, at Connect enablement |
| Stripe issues 1099-K/NEC for Express accounts (US) per current thresholds | Stripe Connect tax docs | payouts/tax | ☐ |
| Closed-loop coins: no withdrawal, no P2P transfer, no cash-out ⇒ outside most stored-value regimes | jurisdiction counsel | coins/gifts | implemented as designed; counsel before non-US launch |
| Minors: no monetization (earn or spend rails already 18+-gated) | platform policy + COPPA/GDPR-K posture (16+ floor) | all | enforced in code |
| DMCA designated agent registration | copyright.gov (US Copyright Office) | copyright center (future phase) | ☐ |

Rule honored: thresholds/legal numbers live in policy rows and this register, not in business logic.
