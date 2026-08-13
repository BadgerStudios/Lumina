-- Parental controls: minor accounts, parent pairing, per-child approved contacts.
--
-- Hand-written from `prisma migrate diff` with its `DROP INDEX "message_search_idx"` stripped, as
-- every migration in this repo must be — that GIN index is created by raw SQL and is invisible to
-- the differ, so it is proposed for deletion every time.

-- CreateEnum
CREATE TYPE "ParentLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');


-- CreateTable
CREATE TABLE "ParentLink" (
    "id" TEXT NOT NULL,
    "childUserId" TEXT NOT NULL,
    "parentUserId" TEXT,
    "status" "ParentLinkStatus" NOT NULL DEFAULT 'PENDING',
    "pairingCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ParentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParentApprovedContact" (
    "id" TEXT NOT NULL,
    "parentLinkId" TEXT NOT NULL,
    "approvedUserId" TEXT NOT NULL,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentApprovedContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParentLink_childUserId_key" ON "ParentLink"("childUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentLink_pairingCode_key" ON "ParentLink"("pairingCode");

-- CreateIndex
CREATE INDEX "ParentLink_parentUserId_idx" ON "ParentLink"("parentUserId");

-- CreateIndex
CREATE INDEX "ParentLink_status_idx" ON "ParentLink"("status");

-- CreateIndex
CREATE INDEX "ParentApprovedContact_approvedUserId_idx" ON "ParentApprovedContact"("approvedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentApprovedContact_parentLinkId_approvedUserId_key" ON "ParentApprovedContact"("parentLinkId", "approvedUserId");

-- AddForeignKey
ALTER TABLE "ParentLink" ADD CONSTRAINT "ParentLink_childUserId_fkey" FOREIGN KEY ("childUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentLink" ADD CONSTRAINT "ParentLink_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentApprovedContact" ADD CONSTRAINT "ParentApprovedContact_parentLinkId_fkey" FOREIGN KEY ("parentLinkId") REFERENCES "ParentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentApprovedContact" ADD CONSTRAINT "ParentApprovedContact_approvedUserId_fkey" FOREIGN KEY ("approvedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

