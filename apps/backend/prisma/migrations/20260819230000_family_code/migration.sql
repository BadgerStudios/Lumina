-- Persistent per-adult family code (reverse-direction parent linking; kept alongside
-- ParentLink.pairingCode). Nullable + unique so existing rows need no backfill and the code is
-- minted lazily on first view of Family Settings.
ALTER TABLE "User" ADD COLUMN "familyCode" TEXT;
CREATE UNIQUE INDEX "User_familyCode_key" ON "User"("familyCode");
