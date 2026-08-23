-- Bot onboarding: a per-server request with a live step log, and the recipe knowledge that makes
-- the second install of the same bot instant.
CREATE TYPE "BotInstallStatus" AS ENUM ('QUEUED', 'RESOLVING', 'PREPARING', 'READY', 'RUNNING', 'FAILED');

CREATE TABLE "BotRecipe" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "repoUrl" TEXT,
    "packageName" TEXT,
    "runtime" TEXT,
    "installCmd" TEXT,
    "startCmd" TEXT,
    "tokenEnvVar" TEXT,
    "apiBaseEnvVar" TEXT,
    "notes" TEXT,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotRecipe_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BotRecipe_sourceKey_key" ON "BotRecipe"("sourceKey");
CREATE INDEX "BotRecipe_verified_idx" ON "BotRecipe"("verified");

CREATE TABLE "BotInstallRequest" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "status" "BotInstallStatus" NOT NULL DEFAULT 'QUEUED',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "recipeId" TEXT,
    "applicationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotInstallRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BotInstallRequest_serverId_idx" ON "BotInstallRequest"("serverId");
CREATE INDEX "BotInstallRequest_status_idx" ON "BotInstallRequest"("status");

ALTER TABLE "BotInstallRequest" ADD CONSTRAINT "BotInstallRequest_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotInstallRequest" ADD CONSTRAINT "BotInstallRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotInstallRequest" ADD CONSTRAINT "BotInstallRequest_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "BotRecipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;
