-- Things a person keeps for themselves.
--
-- Three features that look unrelated and are not: each one is a reason to come back to something
-- you already saw. Saving a message, being reminded about it, and keeping a note about somebody are
-- the same instinct — "I will want this later" — and a platform with no answer to it makes people
-- screenshot things and leave.

-- A message somebody kept.
--
-- The note and the reminder live on this row rather than in separate tables because they are
-- properties of the act of saving, not things of their own: there is no note without a saved
-- message, and a reminder about a message you have not saved has nothing to point at.
CREATE TABLE "SavedMessage" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "messageId"  BIGINT NOT NULL,
    "note"       VARCHAR(500),
    -- Set when the saver asked to be reminded; cleared to NULL once delivered, so the sweeper's
    -- index only ever holds reminders that have not fired.
    "remindAt"   TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedMessage_pkey" PRIMARY KEY ("id")
);

-- Saving twice is the same save. Enforced here rather than in the service because two taps on a
-- slow connection are the normal way this happens.
CREATE UNIQUE INDEX "SavedMessage_userId_messageId_key" ON "SavedMessage"("userId", "messageId");
CREATE INDEX "SavedMessage_userId_createdAt_idx" ON "SavedMessage"("userId", "createdAt");
-- Partial: the sweeper asks for due reminders every minute, and every row that has already fired or
-- never had a reminder is noise in that index forever.
CREATE INDEX "SavedMessage_remindAt_idx" ON "SavedMessage"("remindAt") WHERE "remindAt" IS NOT NULL;

ALTER TABLE "SavedMessage" ADD CONSTRAINT "SavedMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade: a deleted message cannot be reopened, so a saved row pointing at it is dead weight.
ALTER TABLE "SavedMessage" ADD CONSTRAINT "SavedMessage_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A private note one account keeps about another.
--
-- Never visible to its subject, and never part of any moderation surface — this is "met them in
-- the Tuesday raid", not a report. Kept deliberately separate from AccountFlag for that reason: one
-- is a person's own memory, the other is a platform record.
CREATE TABLE "UserNote" (
    "id"        TEXT NOT NULL,
    "authorId"  TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "body"      VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserNote_authorId_subjectId_key" ON "UserNote"("authorId", "subjectId");

ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Daily visit streak.
--
-- Columns on User rather than a table: there is exactly one streak per account and it is read on
-- every session start, so a join would be paid constantly to store three numbers.
--
-- streakDay is a DATE, not a timestamp. A streak is about days, and comparing timestamps makes
-- "did they come back today" depend on the hour they last visited — someone signing in at 23:50 and
-- again at 00:10 would lose a streak they plainly kept.
ALTER TABLE "User" ADD COLUMN "streakDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "streakBest" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "streakDay" DATE;
