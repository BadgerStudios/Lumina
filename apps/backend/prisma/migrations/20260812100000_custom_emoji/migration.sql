-- Custom emoji: server-uploaded :name: emoji, usable in messages and as reactions.
--
-- HAND-WRITTEN. The generated diff leads with `DROP INDEX "message_search_idx"` — that GIN index
-- over Message."searchVector" comes from raw SQL and is absent from schema.prisma, so Prisma reads
-- it as drift. Applying the generated file deletes message search silently. That DROP is the only
-- omission.

-- AlterTable
ALTER TABLE "Reaction" ADD COLUMN     "customEmojiId" TEXT;

-- CreateTable
CREATE TABLE "CustomEmoji" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "uploaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomEmoji_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomEmoji_serverId_idx" ON "CustomEmoji"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomEmoji_serverId_name_key" ON "CustomEmoji"("serverId", "name");

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_customEmojiId_fkey" FOREIGN KEY ("customEmojiId") REFERENCES "CustomEmoji"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
