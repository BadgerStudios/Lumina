-- The app build that registered each token (calls ring natively from build 120).
ALTER TABLE "DeviceToken" ADD COLUMN "build" INTEGER;
