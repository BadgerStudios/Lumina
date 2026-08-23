-- The first-party Lumina community badge. Mirrors User.isOfficial: MASTER-only to set, so an
-- imitation server cannot reproduce it. Default false, which is the safe default for every
-- existing row — no server becomes official by migrating.
ALTER TABLE "Server" ADD COLUMN "isOfficial" BOOLEAN NOT NULL DEFAULT false;
