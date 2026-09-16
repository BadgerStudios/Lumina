-- Roles can be shown as their own group in the member list. Roles that already carried a colour
-- were the ones forming groups before this flag existed, so they start hoisted: nothing changes
-- on screen until someone decides otherwise.
ALTER TABLE "Role" ADD COLUMN "hoist" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Role" SET "hoist" = true WHERE "color" IS NOT NULL AND "isDefault" = false;

-- Keep what a bot registered, so a better Discord→Lumina mapping can be applied at boot.
ALTER TABLE "SlashCommand" ADD COLUMN "discordJson" JSONB,
                           ADD COLUMN "mapperVersion" INTEGER NOT NULL DEFAULT 0;
