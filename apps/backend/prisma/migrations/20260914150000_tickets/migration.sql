-- One queue for everything a moderator works.
--
-- Moderation was three tables that did not know about each other: VideoReport had a queue with a
-- lifecycle, ContentReport (user and message reports) had routes and no UI at all, and images had
-- neither until this week. Support requests had nowhere to go, so people raised them as reports
-- about themselves.
--
-- ContentReport becomes the general ticket table. VideoReport stays where it is — it has a working
-- queue, a leaderboard and reporter ratings built on it, and merging that data is risk for no gain.
-- The two are presented as one queue by the tickets module instead, addressed by a namespaced
-- reference ("c:<id>" / "v:<id>").
CREATE TYPE "TicketCategory" AS ENUM ('USER_REPORT', 'SYSTEM_FLAGGED', 'CUSTOMER_SUPPORT');

ALTER TABLE "ContentReport" ADD COLUMN "category" "TicketCategory" NOT NULL DEFAULT 'USER_REPORT';
-- The one-line summary on the card. Reports derive one from their reason and target; a support
-- ticket is the only thing that has a subject of its own, which is why this is nullable.
ALTER TABLE "ContentReport" ADD COLUMN "subject" VARCHAR(200);
ALTER TABLE "ContentReport" ADD COLUMN "targetAttachmentId" TEXT;

-- A system-flagged ticket has no reporter: the platform raised it, not a person.
ALTER TABLE "ContentReport" ALTER COLUMN "reporterId" DROP NOT NULL;

-- Images are now reportable, and a support ticket is about nothing at all.
ALTER TYPE "ReportTargetType" ADD VALUE 'ATTACHMENT';
ALTER TYPE "ReportTargetType" ADD VALUE 'NONE';

-- Sorting the queue by category, then by what is still open.
CREATE INDEX "ContentReport_category_status_createdAt_idx" ON "ContentReport"("category", "status", "createdAt");

-- Both sides of the conversation.
--
-- ticketRef is a plain string, not a foreign key: a ticket is one of two tables, so there is
-- nothing single to point at. Same reasoning that already keeps ContentReport's target ids
-- relation-less.
CREATE TABLE "TicketMessage" (
    "id"        TEXT NOT NULL,
    "ticketRef" TEXT NOT NULL,
    "authorId"  TEXT,
    -- Stored rather than derived from the author's current rank. A moderator can be promoted or
    -- demoted afterwards, and the archive has to keep showing who was speaking as staff at the
    -- time — deriving it would silently rewrite old conversations.
    "fromStaff" BOOLEAN NOT NULL DEFAULT false,
    -- Internal notes stay out of the reply the reporter sees.
    "internal"  BOOLEAN NOT NULL DEFAULT false,
    "body"      VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketMessage_ticketRef_createdAt_idx" ON "TicketMessage"("ticketRef", "createdAt");

-- SetNull, matching StaffAuditLog: a deleted account must not erase the conversation it was part of.
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
