-- Which message a bot's interaction response created — the anchor for Discord-compat
-- editReply/fetchReply (@original). Additive only.
ALTER TABLE "Interaction" ADD COLUMN "replyMessageId" BIGINT;
