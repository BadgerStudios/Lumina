-- Email verification.
--
-- HAND-WRITTEN, for the same reason as every other migration here: `prisma migrate diff` emits
-- `DROP INDEX "message_search_idx"` first, because that GIN index was created by raw SQL and is
-- absent from schema.prisma. Applying the generated file verbatim deletes message search.
--
-- Nullable with no backfill: every existing account is unverified, and that is correct. Verification
-- gates nothing they already had — see the note in schema.prisma.

ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
