-- Threads (parity Phase 9).
--
-- Hand-written from `prisma migrate diff` with its `DROP INDEX "message_search_idx"` stripped —
-- that GIN index over Message."searchVector" is created by raw SQL and is invisible to the schema
-- differ, so it is proposed for deletion on every single migration. Dropping it degrades message
-- search to a sequential scan silently rather than failing.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's migration transaction, which Postgres 12+
-- permits so long as the new value is not USED in that same transaction. Nothing here does.

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'THREAD';


-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "autoArchiveMinutes" INTEGER NOT NULL DEFAULT 4320,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "threadOriginMessageId" BIGINT;

-- CreateTable
CREATE TABLE "ThreadMembership" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadMembership_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateIndex
CREATE INDEX "ThreadMembership_userId_idx" ON "ThreadMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_threadOriginMessageId_key" ON "Channel"("threadOriginMessageId");

-- CreateIndex
CREATE INDEX "Channel_parentId_archived_idx" ON "Channel"("parentId", "archived");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_threadOriginMessageId_fkey" FOREIGN KEY ("threadOriginMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadMembership" ADD CONSTRAINT "ThreadMembership_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadMembership" ADD CONSTRAINT "ThreadMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

