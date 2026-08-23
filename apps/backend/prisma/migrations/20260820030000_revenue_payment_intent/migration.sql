-- Store the Stripe PaymentIntent id on fiat revenue events so a refund/dispute webhook (which
-- carries the payment_intent, not the session/invoice id) can find the event to reverse.
ALTER TABLE "RevenueEvent" ADD COLUMN "paymentIntentId" TEXT;
CREATE INDEX "RevenueEvent_paymentIntentId_idx" ON "RevenueEvent"("paymentIntentId");
