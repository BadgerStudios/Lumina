-- Game identities (Minecraft first) + per-community Minecraft server address.
-- Differ's spurious DROP INDEX message_search_idx stripped, as every migration here must.

-- CreateEnum
CREATE TYPE "GameProvider" AS ENUM ('MINECRAFT');


-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "minecraftHost" TEXT;

-- CreateTable
CREATE TABLE "GameLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "GameProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalName" TEXT NOT NULL,
    "skinPath" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameLink_verifyCode_key" ON "GameLink"("verifyCode");

-- CreateIndex
CREATE INDEX "GameLink_provider_externalId_idx" ON "GameLink"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "GameLink_userId_provider_key" ON "GameLink"("userId", "provider");

-- AddForeignKey
ALTER TABLE "GameLink" ADD CONSTRAINT "GameLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

