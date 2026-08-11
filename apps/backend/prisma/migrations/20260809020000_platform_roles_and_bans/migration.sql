-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'STAFF', 'OWNER');

-- CreateEnum
CREATE TYPE "BanScope" AS ENUM ('ACCOUNT', 'EMAIL', 'IP', 'DEVICE');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'DENIED');

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "deviceFingerprint" TEXT;

-- AlterTable: add the new role column FIRST, defaulting everyone to USER.
ALTER TABLE "User" ADD COLUMN     "platformRole" "PlatformRole" NOT NULL DEFAULT 'USER';

-- Backfill before dropping the old column. `prisma migrate diff` generates this as a single
-- DROP COLUMN + ADD COLUMN, which would silently reset every existing site admin to USER and lock
-- the owner out of their own review queue. Existing admins become OWNER rather than STAFF: the flag
-- previously granted the highest authority that existed, so mapping it to STAFF would be a demotion.
-- Login-time reconciliation against OWNER_EMAILS/STAFF_EMAILS corrects anything this gets wrong.
UPDATE "User" SET "platformRole" = 'OWNER' WHERE "isSiteAdmin" = true;

-- AlterTable: only now is the old column safe to remove.
ALTER TABLE "User" DROP COLUMN "isSiteAdmin";

-- CreateTable
CREATE TABLE "PlatformBan" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scope" "BanScope" NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "ipAddress" TEXT,
    "deviceFingerprint" TEXT,
    "reason" VARCHAR(500) NOT NULL,
    "bannedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "appealStatus" "AppealStatus" NOT NULL DEFAULT 'NONE',
    "appealText" VARCHAR(1000),
    "appealedAt" TIMESTAMP(3),
    "appealResponse" VARCHAR(500),
    "appealResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformBan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformBan_groupId_idx" ON "PlatformBan"("groupId");

-- CreateIndex
CREATE INDEX "PlatformBan_userId_idx" ON "PlatformBan"("userId");

-- CreateIndex
CREATE INDEX "PlatformBan_email_idx" ON "PlatformBan"("email");

-- CreateIndex
CREATE INDEX "PlatformBan_ipAddress_idx" ON "PlatformBan"("ipAddress");

-- CreateIndex
CREATE INDEX "PlatformBan_deviceFingerprint_idx" ON "PlatformBan"("deviceFingerprint");

-- CreateIndex
CREATE INDEX "PlatformBan_appealStatus_idx" ON "PlatformBan"("appealStatus");

-- AddForeignKey
ALTER TABLE "PlatformBan" ADD CONSTRAINT "PlatformBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBan" ADD CONSTRAINT "PlatformBan_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
