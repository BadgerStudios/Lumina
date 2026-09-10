-- Premium entitlement, denormalised from Subscription. Null = never subscribed; a past
-- date = lapsed. Existing rows start null and are filled by the next subscription webhook.
ALTER TABLE "User" ADD COLUMN "premiumUntil" TIMESTAMP(3);
