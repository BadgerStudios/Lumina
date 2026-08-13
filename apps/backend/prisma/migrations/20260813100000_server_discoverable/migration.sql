-- Opt-in server discovery flag. Hand-written from prisma migrate diff with the usual
-- spurious DROP INDEX "message_search_idx" stripped (raw-SQL GIN index, invisible to the differ).

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "discoverable" BOOLEAN NOT NULL DEFAULT false;

