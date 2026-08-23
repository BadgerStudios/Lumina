-- CreateEnum
CREATE TYPE "ImageframeStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "ImageframeVideo" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "ownerId" TEXT,
    "status" "ImageframeStatus" NOT NULL DEFAULT 'PROCESSING',
    "sourceKey" TEXT NOT NULL,
    "packKey" TEXT,
    "posterKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "gridCols" INTEGER NOT NULL DEFAULT 3,
    "gridRows" INTEGER NOT NULL DEFAULT 2,
    "fps" INTEGER NOT NULL DEFAULT 10,
    "durationMs" INTEGER,
    "srcWidth" INTEGER,
    "srcHeight" INTEGER,
    "frameCount" INTEGER,
    "paletteVersion" INTEGER,
    "failureReason" TEXT,
    "uploadIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageframeVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImageframeVideo_code_key" ON "ImageframeVideo"("code");

-- CreateIndex
CREATE INDEX "ImageframeVideo_status_id_idx" ON "ImageframeVideo"("status", "id");

-- CreateIndex
CREATE INDEX "ImageframeVideo_ownerId_id_idx" ON "ImageframeVideo"("ownerId", "id");
