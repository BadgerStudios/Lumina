-- CreateTable
CREATE TABLE "FriendSuggestionState" (
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3),
    "shownCount" INTEGER NOT NULL DEFAULT 0,
    "lastShownAt" TIMESTAMP(3),

    CONSTRAINT "FriendSuggestionState_pkey" PRIMARY KEY ("userId","subjectId")
);

-- CreateIndex
CREATE INDEX "FriendSuggestionState_userId_dismissedAt_idx" ON "FriendSuggestionState"("userId", "dismissedAt");

-- CreateIndex
CREATE INDEX "DMParticipant_userId_idx" ON "DMParticipant"("userId");

-- AddForeignKey
ALTER TABLE "FriendSuggestionState" ADD CONSTRAINT "FriendSuggestionState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendSuggestionState" ADD CONSTRAINT "FriendSuggestionState_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
