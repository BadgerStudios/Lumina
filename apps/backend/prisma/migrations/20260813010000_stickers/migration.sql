-- Stickers: a server-scoped image sent AS a message.
--
-- Hand-written, NOT the raw output of `prisma migrate diff`. That diff opens with
--   DROP INDEX "message_search_idx";
-- every single time, because the GIN index over Message."searchVector" was created by raw SQL in
-- message_search_and_checks and is therefore invisible to the differ. Pasting the diff verbatim
-- deletes message search, and search then keeps *appearing* to work by sequential scan until the
-- table is large enough to time out. Every migration in this batch has had that line removed.

CREATE TABLE "Sticker" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "uploaderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sticker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Sticker_serverId_idx" ON "Sticker"("serverId");
CREATE UNIQUE INDEX "Sticker_serverId_name_key" ON "Sticker"("serverId", "name");

ALTER TABLE "Sticker" ADD CONSTRAINT "Sticker_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sticker" ADD CONSTRAINT "Sticker_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting a sticker must not delete every message anyone ever sent with
-- it. Same precedent as Message.webhookId and Message.authorId.
ALTER TABLE "Message" ADD COLUMN "stickerId" TEXT;
ALTER TABLE "Message" ADD CONSTRAINT "Message_stickerId_fkey" FOREIGN KEY ("stickerId") REFERENCES "Sticker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
