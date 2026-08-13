-- Per-day view rollup + daily pool-run markers for revenue pool allocation.
-- Additive only; hand-written per the documented workflow (never apply `migrate diff` output
-- verbatim — it emits a DROP for the raw-SQL message_search_idx it cannot see).

CREATE TYPE "PoolRunStatus" AS ENUM ('POSTED', 'EMPTY_POOL', 'NO_QUALIFIED_VIEWS');

CREATE TABLE "VideoViewDay" (
    "id" TEXT NOT NULL,
    "videoId" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VideoViewDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VideoViewDay_videoId_day_key" ON "VideoViewDay"("videoId", "day");
CREATE INDEX "VideoViewDay_day_idx" ON "VideoViewDay"("day");

ALTER TABLE "VideoViewDay" ADD CONSTRAINT "VideoViewDay_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PoolRun" (
    "id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "poolMinor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "status" "PoolRunStatus" NOT NULL,
    "creatorCount" INTEGER NOT NULL DEFAULT 0,
    "residualMinor" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PoolRun_product_day_key" ON "PoolRun"("product", "day");
