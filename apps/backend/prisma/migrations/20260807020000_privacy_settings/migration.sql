-- AlterTable
ALTER TABLE "User" ADD COLUMN     "allowDmsFromNonFriends" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowFriendRequests" BOOLEAN NOT NULL DEFAULT true;
