-- Per-channel permission overwrites (parity Phase 7).
--
-- Hand-written from `prisma migrate diff`, with its `DROP INDEX "message_search_idx"` removed.
-- That index is a GIN index over Message."searchVector" created by raw SQL, so it is invisible to
-- the schema differ and gets proposed for deletion on EVERY migration. Dropping it does not break
-- message search loudly — Postgres falls back to a sequential scan, so it keeps working until the
-- table is large enough to matter, and by then the cause is far away.

-- CreateEnum
CREATE TYPE "OverwriteTargetType" AS ENUM ('ROLE', 'USER');

-- CreateTable
CREATE TABLE "ChannelPermissionOverwrite" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetType" "OverwriteTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "allow" BIGINT NOT NULL DEFAULT 0,
    "deny" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelPermissionOverwrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelPermissionOverwrite_channelId_idx" ON "ChannelPermissionOverwrite"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPermissionOverwrite_channelId_targetType_targetId_key" ON "ChannelPermissionOverwrite"("channelId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "ChannelPermissionOverwrite" ADD CONSTRAINT "ChannelPermissionOverwrite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
