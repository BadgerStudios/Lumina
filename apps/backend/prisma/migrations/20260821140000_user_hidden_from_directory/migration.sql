-- Accounts that may use the product fully but must not be surfaced to strangers by the
-- directory (user search, Discover people). Default false: no existing account changes.
ALTER TABLE "User" ADD COLUMN "hiddenFromDirectory" BOOLEAN NOT NULL DEFAULT false;
