-- Refresh-token families for replay detection (2026-09-08 audit)
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT;
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
