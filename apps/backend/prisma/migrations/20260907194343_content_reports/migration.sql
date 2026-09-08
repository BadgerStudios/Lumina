-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('USER', 'MESSAGE');

-- CreateTable
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetUserId" TEXT,
    "targetMessageId" BIGINT,
    "reason" "ReportReason" NOT NULL,
    "details" VARCHAR(1000),
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "resolutionNote" VARCHAR(1000),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");

-- CreateIndex
CREATE INDEX "ContentReport_targetUserId_idx" ON "ContentReport"("targetUserId");

-- CreateIndex
CREATE INDEX "ContentReport_targetMessageId_idx" ON "ContentReport"("targetMessageId");

