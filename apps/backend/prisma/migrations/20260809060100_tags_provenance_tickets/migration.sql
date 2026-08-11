-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "provenancePurgedAt" TIMESTAMP(3),
ADD COLUMN     "uploadDevice" TEXT,
ADD COLUMN     "uploadIp" TEXT,
ADD COLUMN     "uploadUserAgent" TEXT;
-- AlterTable
ALTER TABLE "VideoReport" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "resolutionNote" VARCHAR(1000);
-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdById" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VideoTag" (
    "videoId" BIGINT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "VideoTag_pkey" PRIMARY KEY ("videoId","tagId")
);
-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");
-- CreateIndex
CREATE INDEX "Tag_useCount_idx" ON "Tag"("useCount");
-- CreateIndex
CREATE INDEX "Tag_name_idx" ON "Tag"("name");
-- CreateIndex
CREATE INDEX "VideoTag_tagId_idx" ON "VideoTag"("tagId");
-- AddForeignKey
ALTER TABLE "VideoReport" ADD CONSTRAINT "VideoReport_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoTag" ADD CONSTRAINT "VideoTag_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoTag" ADD CONSTRAINT "VideoTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
