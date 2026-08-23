-- Age verification now collects a government ID photo alongside the selfie, and both are held for
-- a fixed retention window after the decision rather than being purged the instant it is made.
ALTER TABLE "ManualAgeReview" ADD COLUMN "idDocKey" TEXT;
ALTER TABLE "ManualAgeReview" ADD COLUMN "purgeAfter" TIMESTAMP(3);
