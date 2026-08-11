-- Lumina Control: infrastructure snapshots and a queue of allowlisted service actions.
--
-- Hand-written, minus the `DROP INDEX "message_search_idx"` that `prisma migrate diff` also emits:
-- the full-text search index was created by raw SQL in an earlier migration, so it isn't in the
-- Prisma schema for the diff to compare against, and applying the generated script verbatim would
-- silently delete message search.

-- CreateEnum
CREATE TYPE "OpsCommandStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "OpsSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    CONSTRAINT "OpsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsCommand" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" "OpsCommandStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedById" TEXT,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "result" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpsCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsSnapshot_agentId_id_idx" ON "OpsSnapshot"("agentId", "id");
CREATE INDEX "OpsSnapshot_createdAt_idx" ON "OpsSnapshot"("createdAt");
CREATE INDEX "OpsCommand_agentId_status_idx" ON "OpsCommand"("agentId", "status");
CREATE INDEX "OpsCommand_createdAt_idx" ON "OpsCommand"("createdAt");

-- AddForeignKey
ALTER TABLE "OpsCommand" ADD CONSTRAINT "OpsCommand_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
