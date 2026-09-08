-- CreateTable
CREATE TABLE "ServerFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerFolder_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "folderId" TEXT;

-- CreateIndex
CREATE INDEX "ServerFolder_userId_idx" ON "ServerFolder"("userId");

-- CreateIndex
CREATE INDEX "Membership_folderId_idx" ON "Membership"("folderId");

-- AddForeignKey
ALTER TABLE "ServerFolder" ADD CONSTRAINT "ServerFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ServerFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
