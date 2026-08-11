-- Stitch and duet: consent flags, lineage back to the source video, and a denormalised counter.
--
-- Hand-written rather than pasted from `prisma migrate diff`: that output also contained
-- `DROP INDEX "message_search_idx"`, because the full-text search index was created by raw SQL in
-- an earlier migration and therefore isn't in the Prisma schema for it to compare against.
-- Applying the generated script verbatim would have silently deleted message search.

-- CreateEnum
CREATE TYPE "VideoDerivativeType" AS ENUM ('STITCH', 'DUET');

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "allowDuet" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowStitch" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "derivativeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "derivativeType" "VideoDerivativeType",
ADD COLUMN     "sourceEndMs" INTEGER,
ADD COLUMN     "sourceStartMs" INTEGER,
ADD COLUMN     "sourceVideoId" BIGINT;

-- CreateIndex
CREATE INDEX "Video_sourceVideoId_id_idx" ON "Video"("sourceVideoId", "id");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
