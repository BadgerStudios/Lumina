-- CreateEnum
CREATE TYPE "AgeBracket" AS ENUM ('UNDER_18', 'AGE_18_24', 'AGE_25_34', 'AGE_35_49', 'AGE_50_PLUS');
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ageBracket" "AgeBracket",
ADD COLUMN     "ageRecordedAt" TIMESTAMP(3),
ADD COLUMN     "birthDate" TIMESTAMP(3),
ADD COLUMN     "isMinor" BOOLEAN NOT NULL DEFAULT false;
-- CreateTable
CREATE TABLE "AccountFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "ipHash" TEXT,
    "deviceHash" TEXT,
    "reasonCode" TEXT NOT NULL,
    "detail" VARCHAR(500),
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountFlag_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "AccountFlag_reasonCode_createdAt_idx" ON "AccountFlag"("reasonCode", "createdAt");
-- CreateIndex
CREATE INDEX "AccountFlag_userId_idx" ON "AccountFlag"("userId");
-- CreateIndex
CREATE INDEX "AccountFlag_active_createdAt_idx" ON "AccountFlag"("active", "createdAt");
-- CreateIndex
CREATE INDEX "AccountFlag_deviceHash_idx" ON "AccountFlag"("deviceHash");
-- AddForeignKey
ALTER TABLE "AccountFlag" ADD CONSTRAINT "AccountFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing accounts have no age on record. They are left with ageRecordedAt NULL rather than being
-- assumed adult, and the contact rules treat "unknown" as a minor — the restrictive default is the
-- safe one when the answer genuinely isn't known.
