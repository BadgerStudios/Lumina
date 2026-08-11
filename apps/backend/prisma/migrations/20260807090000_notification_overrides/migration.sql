-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('ALL', 'MENTIONS', 'NONE');

-- CreateTable
CREATE TABLE "NotificationOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL DEFAULT '',
    "level" "NotificationLevel" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationOverride_userId_idx" ON "NotificationOverride"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOverride_userId_serverId_channelId_key" ON "NotificationOverride"("userId", "serverId", "channelId");

-- AddForeignKey
ALTER TABLE "NotificationOverride" ADD CONSTRAINT "NotificationOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOverride" ADD CONSTRAINT "NotificationOverride_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
