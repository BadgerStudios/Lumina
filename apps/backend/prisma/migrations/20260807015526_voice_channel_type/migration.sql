-- Generated via `prisma migrate diff` against a throwaway shadow database (documented
-- non-interactive workaround, see memory), with the recurring false-positive
-- `DROP INDEX "message_search_idx"` stripped (GIN index on Message.searchVector, an
-- Unsupported("tsvector") column migrate diff can't see is still wanted). Do not re-add it.

-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'VOICE';
