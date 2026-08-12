-- Advertiser payments: campaigns become prepaid.
--
-- Hand-written, NOT the output of `prisma migrate diff`. That diff leads with
--   DROP INDEX "message_search_idx";
-- every single time, because the GIN index over Message."searchVector" was created by raw SQL and
-- so does not exist in schema.prisma for the differ to see. Applying it verbatim silently deletes
-- message search — and search keeps "working" by sequential scan until the table is big enough to
-- start timing out, which is the worst possible way to find out.

CREATE TYPE "AdFundingStatus" AS ENUM ('UNFUNDED', 'PENDING', 'FUNDED', 'REFUNDED');

-- Defaults to UNFUNDED: an approved campaign now has to be paid for before it delivers. Safe to
-- apply without grandfathering because the AdCampaign table is empty — checked before writing this,
-- rather than assumed. Were there live campaigns, they would need an explicit UPDATE to FUNDED here,
-- or the deploy would silently stop every running ad.
ALTER TABLE "AdCampaign"
  ADD COLUMN "fundingStatus" "AdFundingStatus" NOT NULL DEFAULT 'UNFUNDED',
  ADD COLUMN "paidCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "stripeSessionId" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3);

-- Unique, so a redelivered checkout.session.completed cannot fund the same campaign twice. Stripe
-- redelivers on any non-2xx as normal operation, so this is a routine case, not an edge one.
CREATE UNIQUE INDEX "AdCampaign_stripeSessionId_key" ON "AdCampaign"("stripeSessionId");
