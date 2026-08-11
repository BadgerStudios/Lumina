-- Generated via `prisma migrate diff` against a throwaway shadow database (non-interactive
-- environment can't run `prisma migrate dev`), then hand-edited to drop a false-positive
-- `DROP INDEX "message_search_idx"` the diff tool proposed: that GIN index lives on the
-- Message.searchVector Unsupported("tsvector") column and was created by hand-written SQL in
-- the message_search_and_checks migration, so `migrate diff` can't see it's still wanted from
-- schema.prisma alone. Dropping it would silently degrade full-text search — do not re-add it.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "applicationId" TEXT,
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "botTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Application_ownerId_idx" ON "Application"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_applicationId_key" ON "User"("applicationId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
