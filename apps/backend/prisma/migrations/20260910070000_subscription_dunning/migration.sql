-- Which invoice this subscriber was last warned about. Null = never warned, or the last
-- attempt succeeded and the slate was cleared.
ALTER TABLE "Subscription" ADD COLUMN "dunningInvoiceId" TEXT;
