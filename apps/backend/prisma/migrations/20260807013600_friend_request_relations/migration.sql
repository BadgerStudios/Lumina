-- Generated via `prisma migrate diff` against a throwaway shadow database (documented
-- non-interactive workaround, see memory), with the recurring false-positive
-- `DROP INDEX "message_search_idx"` stripped (GIN index on Message.searchVector, an
-- Unsupported("tsvector") column migrate diff can't see is still wanted). Do not re-add it.
--
-- FriendRequest.requesterId/addresseeId were plain String columns with no @relation/FK at all
-- since the very first migration — added real foreign keys now that routes are being built for
-- it. Table has never had a route or a row, so no data to worry about.

-- CreateIndex
CREATE INDEX "FriendRequest_addresseeId_idx" ON "FriendRequest"("addresseeId");

-- AddForeignKey
ALTER TABLE "FriendRequest" ADD CONSTRAINT "FriendRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendRequest" ADD CONSTRAINT "FriendRequest_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
