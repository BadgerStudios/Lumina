-- Server settings: moderation gates, member defaults, AFK voice, system messages, community info.
--
-- HAND-WRITTEN. `prisma migrate diff` emits `DROP INDEX "message_search_idx"` as its third
-- statement — that GIN index over Message."searchVector" was created by raw SQL and is absent from
-- schema.prisma, so Prisma reads it as drift and removes it. Applying the generated file deletes
-- message search silently. That DROP is the only omission; the rest is the generated output.

-- CreateEnum
CREATE TYPE "VerificationLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ExplicitContentFilter" AS ENUM ('DISABLED', 'MEMBERS_WITHOUT_ROLES', 'ALL_MEMBERS');

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "afkChannelId" TEXT,
ADD COLUMN     "afkTimeoutSec" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "defaultNotificationLevel" "NotificationLevel" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "explicitContentFilter" "ExplicitContentFilter" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "rulesChannelId" TEXT,
ADD COLUMN     "sysBoostMessages" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sysJoinMessages" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sysLeaveMessages" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vanityCode" TEXT,
ADD COLUMN     "verificationLevel" "VerificationLevel" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE UNIQUE INDEX "Server_vanityCode_key" ON "Server"("vanityCode");
