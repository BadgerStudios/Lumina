-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REMOVED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSiteAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Video" (
    "id" BIGSERIAL NOT NULL,
    "authorId" TEXT,
    "caption" VARCHAR(300),
    "status" "VideoStatus" NOT NULL DEFAULT 'PROCESSING',
    "sourceKey" TEXT NOT NULL,
    "playbackKey" TEXT,
    "thumbnailKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "failureReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(300),
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Video_status_id_idx" ON "Video"("status", "id");

-- CreateIndex
CREATE INDEX "Video_authorId_id_idx" ON "Video"("authorId", "id");

-- CreateIndex
CREATE INDEX "Video_sha256_idx" ON "Video"("sha256");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
