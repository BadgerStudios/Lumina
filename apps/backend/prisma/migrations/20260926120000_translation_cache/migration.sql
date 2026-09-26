-- CreateTable
CREATE TABLE "TranslationCache" (
    "lang" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationCache_pkey" PRIMARY KEY ("lang","hash")
);
