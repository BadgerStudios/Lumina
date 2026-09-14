-- Lumina staff becomes a ladder rather than a single rung.
--
-- STAFF is RENAMED to MODERATOR rather than dropped and re-added: a rename keeps every existing row
-- pointing at the same value, so nobody's access changes as this runs. Dropping and re-adding would
-- mean rewriting every User row and would fail outright against the enum still being referenced.
ALTER TYPE "PlatformRole" RENAME VALUE 'STAFF' TO 'MODERATOR';

-- The two new rungs sit between MODERATOR and OWNER. Position matters only for Postgres' own
-- ordering of the type (which is what makes ORDER BY on the column read as seniority); authority is
-- decided by the RANK table in backend lib/platformRole.ts, and the two must be kept in step.
--
-- ADD VALUE inside a transaction is allowed from Postgres 12 on, provided the new value is not USED
-- in the same transaction. Nothing here writes one, so this is safe under `prisma migrate deploy`,
-- which wraps each migration in a transaction.
ALTER TYPE "PlatformRole" ADD VALUE 'ADMIN' AFTER 'MODERATOR';
ALTER TYPE "PlatformRole" ADD VALUE 'EXECUTIVE' AFTER 'ADMIN';
