-- Indexes on foreign keys that sit on hot paths.
--
-- Hand-written, NOT the output of `prisma migrate diff` — that diff opens with
--   DROP INDEX "message_search_idx";
-- every time, because the GIN index over Message."searchVector" was created by raw SQL and so is
-- invisible to the differ. Applying it verbatim deletes message search, and search keeps appearing
-- to work (by sequential scan) until the table is big enough to time out.
--
-- Postgres does NOT index foreign keys automatically. Twenty-five FKs here have no index; these
-- four are the ones where the absence has a user-visible consequence rather than a theoretical one:
--
--   Message.authorId        Account deletion sets it null across every message the user ever wrote,
--                           and the data export reads the same column. Both were a full scan of
--                           Message per request.
--   RoleAssignment.roleId   "Who holds this role" runs inside permission computation, which runs on
--                           every message send. The existing @@unique is keyed on membershipId
--                           first, so it cannot serve a lookup by role.
--   Attachment.messageId    Joined on every message-list render.
--   MessageMention.messageId  Same.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: Prisma wraps each migration in a transaction, and
-- CONCURRENTLY cannot run inside one. These tables are small today so the brief lock is
-- unnoticeable — worth revisiting if Message ever gets large enough for the lock to matter.

CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");
CREATE INDEX "RoleAssignment_roleId_idx" ON "RoleAssignment"("roleId");
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
CREATE INDEX "MessageMention_messageId_idx" ON "MessageMention"("messageId");
