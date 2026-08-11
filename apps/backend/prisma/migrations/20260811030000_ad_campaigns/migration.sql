-- Self-serve advertising: promoted videos in the For You feed.
--
-- Hand-written, minus the DROP INDEX "message_search_idx" prisma migrate diff also emits (that
-- full-text index is raw SQL from an earlier migration and isn't in the Prisma schema).

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'COMPLETED');


-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT,
    "videoId" BIGINT,
    "name" VARCHAR(100) NOT NULL,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "cpmCents" INTEGER NOT NULL,
    "totalBudgetCents" INTEGER NOT NULL,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "targetTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "impressionCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaignDaily" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spentCents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AdCampaignDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCampaign_status_startsAt_endsAt_idx" ON "AdCampaign"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AdCampaign_advertiserId_createdAt_idx" ON "AdCampaign"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdCampaignDaily_day_idx" ON "AdCampaignDaily"("day");

-- CreateIndex
CREATE UNIQUE INDEX "AdCampaignDaily_campaignId_day_key" ON "AdCampaignDaily"("campaignId", "day");

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaignDaily" ADD CONSTRAINT "AdCampaignDaily_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

