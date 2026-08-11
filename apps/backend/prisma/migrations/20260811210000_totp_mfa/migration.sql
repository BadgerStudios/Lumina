-- Two-factor authentication (TOTP).
--
-- HAND-WRITTEN, and the difference from the generated output matters: `prisma migrate diff` also
-- emits `DROP INDEX "message_search_idx"`, because that GIN index over Message."searchVector" was
-- created by raw SQL in an earlier migration and therefore does not appear in schema.prisma. Prisma
-- sees an index the schema does not describe and helpfully removes it. Applying the generated file
-- verbatim would silently delete message search — the feature would keep returning results, just
-- via a sequential scan, until the table grew enough to time out.
--
-- The rule for this repo: never apply generated migration SQL without reading it first.

ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);

CREATE TABLE "TotpBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TotpBackupCode_userId_idx" ON "TotpBackupCode"("userId");

ALTER TABLE "TotpBackupCode" ADD CONSTRAINT "TotpBackupCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
