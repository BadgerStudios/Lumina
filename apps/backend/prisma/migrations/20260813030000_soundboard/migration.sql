-- Soundboard. Hand-written; see the stickers migration for why the differ's output is never pasted
-- verbatim (it opens by dropping the message-search index).

CREATE TABLE "SoundboardSound" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "emoji" TEXT,
    "durationMs" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoundboardSound_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SoundboardSound_serverId_idx" ON "SoundboardSound"("serverId");
CREATE UNIQUE INDEX "SoundboardSound_serverId_name_key" ON "SoundboardSound"("serverId", "name");

ALTER TABLE "SoundboardSound" ADD CONSTRAINT "SoundboardSound_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SoundboardSound" ADD CONSTRAINT "SoundboardSound_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
