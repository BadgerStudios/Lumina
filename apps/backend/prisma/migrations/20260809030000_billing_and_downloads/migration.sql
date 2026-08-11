-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'UNPAID');
-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('CHARGE', 'REFUND');
-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "planKey" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "stripeEventId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "kind" "TransactionKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AppDownload" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "version" TEXT,
    "fileName" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppDownload_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");
-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");
-- CreateIndex
CREATE UNIQUE INDEX "Transaction_stripeEventId_key" ON "Transaction"("stripeEventId");
-- CreateIndex
CREATE INDEX "Transaction_createdAt_idx" ON "Transaction"("createdAt");
-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");
-- CreateIndex
CREATE INDEX "AppDownload_createdAt_idx" ON "AppDownload"("createdAt");
-- CreateIndex
CREATE INDEX "AppDownload_platform_createdAt_idx" ON "AppDownload"("platform", "createdAt");
-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
