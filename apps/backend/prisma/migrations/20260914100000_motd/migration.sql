-- The owner's message of the day, plus the per-member record of having seen one.
--
-- Rows rather than one mutable record, so an edit is a new notice with its own identity: that is
-- what lets "once per person per day" and "a new notice appears immediately" both hold. Retiring is
-- active = false rather than a delete, so what was shown, when, and by whom stays answerable.
CREATE TABLE "Motd" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "Motd_pkey" PRIMARY KEY ("id")
);

-- The read path is always "the active notice, newest first", which is exactly this index.
CREATE INDEX "Motd_active_createdAt_idx" ON "Motd"("active", "createdAt");

-- SET NULL rather than CASCADE: a notice outlives the account that published it. Losing the author
-- is acceptable, losing the record of what everyone was shown is not.
ALTER TABLE "Motd" ADD CONSTRAINT "Motd_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Both columns are needed and they answer different questions: the id makes a newly published
-- notice appear at once, the timestamp makes an unchanged one return the next day. Existing rows
-- start null, which reads as "has seen nothing" — correct for everyone on the day this ships.
ALTER TABLE "User" ADD COLUMN "motdSeenId" TEXT;
ALTER TABLE "User" ADD COLUMN "motdSeenAt" TIMESTAMP(3);
