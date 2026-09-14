-- Images get reviewed after the fact, not before.
--
-- Every attachment starts PENDING and is visible the moment it is posted. Holding images until
-- somebody looked would make chat unusable and is not what was asked for: the queue is a sweep of
-- what has been sent, with reported ones first. REMOVED is the state that actually takes one down —
-- both the serializer and the file route refuse it, and the bytes are unlinked at the same time.
CREATE TYPE "AttachmentReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REMOVED');

ALTER TABLE "Attachment" ADD COLUMN "reviewStatus" "AttachmentReviewStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Attachment" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Attachment" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "removalReason" VARCHAR(500);

-- The queue's only ordering: oldest pending first, so nothing waits indefinitely behind a busy day.
CREATE INDEX "Attachment_reviewStatus_createdAt_idx" ON "Attachment"("reviewStatus", "createdAt");

-- SetNull, matching StaffAuditLog: a reviewer's account being deleted must not erase the record
-- that the image WAS reviewed, only who did it.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
