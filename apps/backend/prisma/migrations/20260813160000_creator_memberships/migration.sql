-- Creator memberships: supporter tiers + recurring membership relationships. Additive only.

CREATE TYPE "CreatorMembershipStatus" AS ENUM ('INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELED');

CREATE TABLE "CreatorTier" (
    "creatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Supporter',
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTier_pkey" PRIMARY KEY ("creatorId")
);

ALTER TABLE "CreatorTier" ADD CONSTRAINT "CreatorTier_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorMembership" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "CreatorMembershipStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "priceMinor" INTEGER NOT NULL,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorMembership_stripeSubscriptionId_key" ON "CreatorMembership"("stripeSubscriptionId");
CREATE UNIQUE INDEX "CreatorMembership_creatorId_memberId_key" ON "CreatorMembership"("creatorId", "memberId");
CREATE INDEX "CreatorMembership_memberId_idx" ON "CreatorMembership"("memberId");

ALTER TABLE "CreatorMembership" ADD CONSTRAINT "CreatorMembership_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorMembership" ADD CONSTRAINT "CreatorMembership_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
