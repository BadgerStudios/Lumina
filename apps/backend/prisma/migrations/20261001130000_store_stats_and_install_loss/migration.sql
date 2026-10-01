-- CreateTable
CREATE TABLE "AppInstallLoss" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "app" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "build" INTEGER,
    "installedAt" TIMESTAMP(3) NOT NULL,
    "lostAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detectedBy" VARCHAR(16) NOT NULL,
    "recoveredAt" TIMESTAMP(3),

    CONSTRAINT "AppInstallLoss_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreStatsSnapshot" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "day" DATE NOT NULL,
    "metric" VARCHAR(32) NOT NULL,
    "platform" VARCHAR(16) NOT NULL DEFAULT 'all',
    "value" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreStatsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppInstallLoss_lostAt_idx" ON "AppInstallLoss"("lostAt");

-- CreateIndex
CREATE INDEX "AppInstallLoss_userId_app_idx" ON "AppInstallLoss"("userId", "app");

-- CreateIndex
CREATE UNIQUE INDEX "StoreStatsSnapshot_source_day_metric_platform_key" ON "StoreStatsSnapshot"("source", "day", "metric", "platform");

-- CreateIndex
CREATE INDEX "StoreStatsSnapshot_source_metric_day_idx" ON "StoreStatsSnapshot"("source", "metric", "day");

-- AddForeignKey
ALTER TABLE "AppInstallLoss" ADD CONSTRAINT "AppInstallLoss_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
