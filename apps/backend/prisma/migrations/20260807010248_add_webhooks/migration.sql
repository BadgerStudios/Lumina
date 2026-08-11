-- Generated via `prisma migrate diff` against a throwaway shadow database (documented
-- non-interactive workaround, see memory), with the recurring false-positive
-- `DROP INDEX "message_search_idx"` stripped (GIN index on Message.searchVector, an
-- Unsupported("tsvector") column migrate diff can't see is still wanted). Do not re-add it.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "overrideAvatarUrl" TEXT,
ADD COLUMN     "overrideUsername" TEXT,
ADD COLUMN     "webhookId" TEXT;

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "tokenHash" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Webhook_channelId_idx" ON "Webhook"("channelId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
