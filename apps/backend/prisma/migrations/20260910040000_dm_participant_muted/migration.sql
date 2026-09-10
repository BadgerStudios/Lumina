-- Per-participant mute for a DM conversation. Defaults false, so every existing
-- participant keeps the behaviour they have today.
ALTER TABLE "DMParticipant" ADD COLUMN "muted" BOOLEAN NOT NULL DEFAULT false;
