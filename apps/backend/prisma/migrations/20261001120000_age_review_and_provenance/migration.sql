-- Sign-up provenance and owner age review on User
ALTER TABLE "User" ADD COLUMN "signupIp" VARCHAR(64),
  ADD COLUMN "signupUserAgent" VARCHAR(400),
  ADD COLUMN "signupDevice" VARCHAR(128),
  ADD COLUMN "signupClient" VARCHAR(32),
  ADD COLUMN "ageReview" VARCHAR(16),
  ADD COLUMN "ageReviewReason" VARCHAR(300),
  ADD COLUMN "ageReviewedAt" TIMESTAMP(3),
  ADD COLUMN "ageReviewedById" TEXT;
CREATE INDEX "User_ageReview_idx" ON "User"("ageReview");

-- Plaintext provenance on age-refusal flags (purged after 90 days)
ALTER TABLE "AccountFlag" ADD COLUMN "ipAddress" VARCHAR(64),
  ADD COLUMN "userAgent" VARCHAR(400),
  ADD COLUMN "country" VARCHAR(2),
  ADD COLUMN "clientType" VARCHAR(32),
  ADD COLUMN "provenancePurgedAt" TIMESTAMP(3);
CREATE INDEX "AccountFlag_ipAddress_idx" ON "AccountFlag"("ipAddress");
