-- WebAuthn passkeys.
--
-- HAND-WRITTEN. `prisma migrate diff` again emitted `DROP INDEX "message_search_idx"` first, for the
-- same reason as every other migration in this repo: that GIN index over Message."searchVector" was
-- created by raw SQL and so does not appear in schema.prisma, and Prisma removes what the schema
-- does not describe. Applying generated SQL verbatim here would delete message search.

CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Passkey_userId_idx" ON "Passkey"("userId");

ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
