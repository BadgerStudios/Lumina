-- Retention (inbox, XP) + creator economy core (ledger, revenue events, policy, wallets,
-- earnings, program, payouts, gifts). Differ's spurious DROP INDEX stripped as always.

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('REPLY', 'REACTION', 'VIDEO_LIKE', 'VIDEO_COMMENT', 'THREAD', 'FRIEND_ACCEPT', 'LEVEL_UP', 'EARNING');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "RevenueEventStatus" AS ENUM ('RECEIVED', 'QUALIFIED', 'EXCLUDED', 'POSTED');

-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'REVERSED', 'PAID');

-- CreateEnum
CREATE TYPE "CreatorProgramState" AS ENUM ('NOT_ELIGIBLE', 'LIMITED', 'CREATOR', 'SUSPENDED', 'PAYOUT_RESTRICTED');

-- CreateEnum
CREATE TYPE "PayoutState" AS ENUM ('NOT_READY', 'PENDING_KYC', 'AVAILABLE', 'SCHEDULED', 'SUBMITTED', 'PAID', 'FAILED', 'REVERSED');


-- CreateTable
CREATE TABLE "Notification" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "bundleKey" TEXT NOT NULL,
    "actorId" TEXT,
    "actorCount" INTEGER NOT NULL DEFAULT 1,
    "messageId" BIGINT,
    "channelId" TEXT,
    "serverId" TEXT,
    "videoId" TEXT,
    "preview" VARCHAR(140),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberXp" (
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "lastAwardAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberXp_pkey" PRIMARY KEY ("userId","serverId")
);

-- CreateTable
CREATE TABLE "LevelReward" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "LevelReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "externalRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "subjectUserId" TEXT,
    "contentRef" TEXT,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "RevenueEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" VARCHAR(3) NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "userId" TEXT,
    "creatorId" TEXT,
    "contentRef" TEXT,
    "externalRef" TEXT,
    "riskContext" JSONB,
    "excludedReason" TEXT,
    "ledgerTxId" TEXT,
    "policyVersion" INTEGER,

    CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenuePolicy" (
    "id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "creatorBps" INTEGER NOT NULL,
    "platformBps" INTEGER NOT NULL,
    "holdDays" INTEGER NOT NULL,
    "reserveBps" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "RevenuePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorWallet" (
    "userId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "pendingMinor" BIGINT NOT NULL DEFAULT 0,
    "availableMinor" BIGINT NOT NULL DEFAULT 0,
    "reservedMinor" BIGINT NOT NULL DEFAULT 0,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorWallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "EarningItem" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "revenueEventId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorProgram" (
    "userId" TEXT NOT NULL,
    "state" "CreatorProgramState" NOT NULL DEFAULT 'NOT_ELIGIBLE',
    "requirements" JSONB,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProgram_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerAccount" TEXT,
    "onboarded" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "state" "PayoutState" NOT NULL DEFAULT 'NOT_READY',
    "idempotencyKey" TEXT NOT NULL,
    "externalRef" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gift" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "priceCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftSend" (
    "id" TEXT NOT NULL,
    "giftId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "contentRef" TEXT,
    "priceCoins" INTEGER NOT NULL,
    "revenueEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_updatedAt_idx" ON "Notification"("userId", "readAt", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_bundleKey_key" ON "Notification"("userId", "bundleKey");

-- CreateIndex
CREATE INDEX "MemberXp_serverId_xp_idx" ON "MemberXp"("serverId", "xp");

-- CreateIndex
CREATE UNIQUE INDEX "LevelReward_serverId_level_roleId_key" ON "LevelReward"("serverId", "level", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_externalRef_key" ON "LedgerTransaction"("externalRef");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountCode_subjectUserId_idx" ON "LedgerEntry"("accountCode", "subjectUserId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_idempotencyKey_key" ON "RevenueEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RevenueEvent_creatorId_occurredAt_idx" ON "RevenueEvent"("creatorId", "occurredAt");

-- CreateIndex
CREATE INDEX "RevenueEvent_status_idx" ON "RevenueEvent"("status");

-- CreateIndex
CREATE INDEX "RevenuePolicy_product_effectiveFrom_idx" ON "RevenuePolicy"("product", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RevenuePolicy_product_version_key" ON "RevenuePolicy"("product", "version");

-- CreateIndex
CREATE UNIQUE INDEX "EarningItem_revenueEventId_key" ON "EarningItem"("revenueEventId");

-- CreateIndex
CREATE INDEX "EarningItem_creatorId_status_idx" ON "EarningItem"("creatorId", "status");

-- CreateIndex
CREATE INDEX "EarningItem_status_availableAt_idx" ON "EarningItem"("status", "availableAt");

-- CreateIndex
CREATE INDEX "CreatorProgram_state_idx" ON "CreatorProgram"("state");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccount_providerAccount_key" ON "PayoutAccount"("providerAccount");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_externalRef_key" ON "Payout"("externalRef");

-- CreateIndex
CREATE INDEX "Payout_creatorId_state_idx" ON "Payout"("creatorId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Gift_key_key" ON "Gift"("key");

-- CreateIndex
CREATE UNIQUE INDEX "GiftSend_revenueEventId_key" ON "GiftSend"("revenueEventId");

-- CreateIndex
CREATE INDEX "GiftSend_creatorId_createdAt_idx" ON "GiftSend"("creatorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberXp" ADD CONSTRAINT "MemberXp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberXp" ADD CONSTRAINT "MemberXp_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LevelReward" ADD CONSTRAINT "LevelReward_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LevelReward" ADD CONSTRAINT "LevelReward_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorWallet" ADD CONSTRAINT "CreatorWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningItem" ADD CONSTRAINT "EarningItem_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorProgram" ADD CONSTRAINT "CreatorProgram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftSend" ADD CONSTRAINT "GiftSend_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "Gift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftSend" ADD CONSTRAINT "GiftSend_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftSend" ADD CONSTRAINT "GiftSend_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Coin spend reason for gifts
ALTER TYPE "CoinReason" ADD VALUE 'GIFT_SEND';
