-- Layered age-assurance stack: native device bands + Persona + admin selfie review.
-- All additive: new enums, new nullable/defaulted User columns, three new tables.

CREATE TYPE "AgeAssuranceLevel" AS ENUM ('SELF_DECLARED', 'DEVICE_DECLARED', 'DOCUMENT_VERIFIED');
CREATE TYPE "ManualAgeReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "ManualAgeDecision" AS ENUM ('ADULT', 'MINOR');

ALTER TABLE "User"
  ADD COLUMN "ageAssuranceLevel" "AgeAssuranceLevel" NOT NULL DEFAULT 'SELF_DECLARED',
  ADD COLUMN "ageAssuranceSource" TEXT,
  ADD COLUMN "ageAssuredBand" TEXT,
  ADD COLUMN "ageAssuredAt" TIMESTAMP(3),
  ADD COLUMN "identityVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "personaInquiryId" TEXT,
  ADD COLUMN "personaStatus" TEXT;

CREATE UNIQUE INDEX "User_personaInquiryId_key" ON "User"("personaInquiryId");

CREATE TABLE "AgeVerification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "level" "AgeAssuranceLevel" NOT NULL,
  "source" TEXT NOT NULL,
  "band" TEXT,
  "isMinorSignal" BOOLEAN,
  "inquiryId" TEXT,
  "rawStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgeVerification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgeVerification_userId_idx" ON "AgeVerification"("userId");
CREATE INDEX "AgeVerification_inquiryId_idx" ON "AgeVerification"("inquiryId");
ALTER TABLE "AgeVerification" ADD CONSTRAINT "AgeVerification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ManualAgeReview" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "selfieKey" TEXT,
  "status" "ManualAgeReviewStatus" NOT NULL DEFAULT 'PENDING',
  "decision" "ManualAgeDecision",
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "note" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualAgeReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ManualAgeReview_userId_idx" ON "ManualAgeReview"("userId");
CREATE INDEX "ManualAgeReview_status_idx" ON "ManualAgeReview"("status");
ALTER TABLE "ManualAgeReview" ADD CONSTRAINT "ManualAgeReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PersonaBudget" (
  "periodYm" TEXT NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PersonaBudget_pkey" PRIMARY KEY ("periodYm")
);
