-- Which invite brought each member in. Nullable: existing memberships predate it, and a
-- join through the discovery directory has no invite behind it.
ALTER TABLE "Membership" ADD COLUMN "joinedViaCode" TEXT;

-- Answers "where did this cohort come from" without scanning the table.
CREATE INDEX "Membership_joinedViaCode_idx" ON "Membership"("joinedViaCode");
