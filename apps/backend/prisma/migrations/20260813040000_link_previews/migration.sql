-- Link previews. Hand-written; see the stickers migration for why the differ's output is never
-- pasted verbatim (it opens by dropping the message-search index).

CREATE TYPE "LinkPreviewStatus" AS ENUM ('PENDING', 'OK', 'EMPTY', 'BLOCKED', 'FAILED');

CREATE TABLE "LinkPreview" (
    "id" TEXT NOT NULL,
    -- SHA-256 of the normalized URL rather than the URL itself. A unique btree index on the raw
    -- string is a latent 500: Postgres btree keys top out near 2704 bytes and URLs do not.
    "urlHash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "LinkPreviewStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "siteName" TEXT,
    "failReason" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkPreview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageEmbed" (
    "messageId" BIGINT NOT NULL,
    "previewId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "MessageEmbed_pkey" PRIMARY KEY ("messageId","previewId")
);

CREATE UNIQUE INDEX "LinkPreview_urlHash_key" ON "LinkPreview"("urlHash");
CREATE INDEX "LinkPreview_fetchedAt_idx" ON "LinkPreview"("fetchedAt");
CREATE INDEX "MessageEmbed_previewId_idx" ON "MessageEmbed"("previewId");

ALTER TABLE "MessageEmbed" ADD CONSTRAINT "MessageEmbed_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageEmbed" ADD CONSTRAINT "MessageEmbed_previewId_fkey" FOREIGN KEY ("previewId") REFERENCES "LinkPreview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
