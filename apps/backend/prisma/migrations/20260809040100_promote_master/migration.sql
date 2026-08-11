-- Promotes the platform's master account. Separate migration from the enum change above for the
-- transaction reason documented there.
--
-- Idempotent and safe on an empty database: if this username doesn't exist the UPDATE simply
-- affects zero rows. The MASTER_EMAIL env var is the ongoing source of truth — login-time
-- reconciliation re-applies it, so this is a one-time seed, not the mechanism.
UPDATE "User" SET "platformRole" = 'MASTER' WHERE "username" = 'Lucidbadger1';
