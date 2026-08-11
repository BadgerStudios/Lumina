-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'VIOLENCE', 'SEXUAL_CONTENT', 'HATE_SPEECH', 'SELF_HARM', 'ILLEGAL', 'OTHER');
-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
-- CreateTable
CREATE TABLE "VideoComment" (
    "id" BIGSERIAL NOT NULL,
    "videoId" BIGINT NOT NULL,
    "authorId" TEXT,
    "content" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoComment_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VideoReport" (
    "id" TEXT NOT NULL,
    "videoId" BIGINT NOT NULL,
    "reporterId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" VARCHAR(500),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoReport_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "VideoComment_videoId_id_idx" ON "VideoComment"("videoId", "id");
-- CreateIndex
CREATE INDEX "VideoReport_status_createdAt_idx" ON "VideoReport"("status", "createdAt");
-- CreateIndex
CREATE INDEX "VideoReport_videoId_idx" ON "VideoReport"("videoId");
-- CreateIndex
CREATE UNIQUE INDEX "VideoReport_videoId_reporterId_key" ON "VideoReport"("videoId", "reporterId");
-- AddForeignKey
ALTER TABLE "VideoComment" ADD CONSTRAINT "VideoComment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoComment" ADD CONSTRAINT "VideoComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoReport" ADD CONSTRAINT "VideoReport_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoReport" ADD CONSTRAINT "VideoReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "VideoReport" ADD CONSTRAINT "VideoReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
