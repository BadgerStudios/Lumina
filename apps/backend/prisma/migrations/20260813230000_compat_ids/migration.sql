-- Numeric id aliases for the Discord compatibility layer. Additive only.

CREATE TABLE "CompatId" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "luminaId" TEXT NOT NULL,

    CONSTRAINT "CompatId_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompatId_kind_luminaId_key" ON "CompatId"("kind", "luminaId");
