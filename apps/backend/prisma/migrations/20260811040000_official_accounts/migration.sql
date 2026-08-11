-- Official first-party accounts: a badge that cannot be faked by setting a bio.


-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isOfficial" BOOLEAN NOT NULL DEFAULT false;

