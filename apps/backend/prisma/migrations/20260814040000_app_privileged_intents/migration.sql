-- Privileged-intent toggles per application, Discord-dev-portal style. Default OFF: a bot must
-- declare what it reads, and its owner must switch the sensitive ones on deliberately.
ALTER TABLE "Application" ADD COLUMN "intentMessageContent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "intentServerMembers" BOOLEAN NOT NULL DEFAULT false;
