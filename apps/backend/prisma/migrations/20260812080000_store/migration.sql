-- Store: first-party cosmetics bought with an in-app currency.
--
-- HAND-WRITTEN, NOT GENERATED. `prisma migrate diff` emits `DROP INDEX "message_search_idx"` as its
-- sixth statement: that GIN index over Message."searchVector" was created by raw SQL in an earlier
-- migration and so does not appear in schema.prisma, which makes Prisma think it is drift and
-- helpfully remove it. Applying the generated file deletes message search, and not loudly — search
-- keeps returning results by sequential scan until the table is large enough to time out. The DROP
-- is the only omission; everything else below is the generated output verbatim.

-- CreateEnum
CREATE TYPE "StoreItemKind" AS ENUM ('THEME', 'ACCENT', 'BADGE', 'PROFILE_EFFECT');

-- CreateEnum
CREATE TYPE "CoinReason" AS ENUM ('PURCHASE_BUNDLE', 'SPEND_STORE', 'PROMO_GRANT', 'ADMIN_ADJUST', 'REFUND');

-- CreateTable
CREATE TABLE "StoreItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "kind" "StoreItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "priceCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinLedgerEntry" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "CoinReason" NOT NULL,
    "refId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreItem_sku_key" ON "StoreItem"("sku");

-- CreateIndex
CREATE INDEX "StoreItem_active_sortOrder_idx" ON "StoreItem"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "StoreGrant_userId_idx" ON "StoreGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreGrant_userId_itemId_key" ON "StoreGrant"("userId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinLedgerEntry_refId_key" ON "CoinLedgerEntry"("refId");

-- CreateIndex
CREATE INDEX "CoinLedgerEntry_userId_createdAt_idx" ON "CoinLedgerEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "StoreGrant" ADD CONSTRAINT "StoreGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreGrant" ADD CONSTRAINT "StoreGrant_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StoreItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinLedgerEntry" ADD CONSTRAINT "CoinLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
