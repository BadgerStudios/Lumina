-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "nsfw" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slowmodeSeconds" INTEGER NOT NULL DEFAULT 0;
