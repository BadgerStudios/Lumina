-- Which tone this phone plays, per kind of notification.
--
-- Per device rather than per account on purpose: a tone is a property of a phone in a pocket, and
-- the same person can reasonably want a different one on a tablet. It also lives beside the token
-- because that is what the send path already has in hand — one row read, no join.
--
-- Four columns rather than one JSON blob so a kind added later is a migration, not a shape that
-- some rows have and some do not. Defaults are the owner's chosen tone, so a device that has never
-- picked plays the right thing from its first notification rather than a silent channel.

ALTER TABLE "DeviceToken" ADD COLUMN "messageSound" TEXT NOT NULL DEFAULT 'mist';
ALTER TABLE "DeviceToken" ADD COLUMN "directSound"  TEXT NOT NULL DEFAULT 'mist';
ALTER TABLE "DeviceToken" ADD COLUMN "mentionSound" TEXT NOT NULL DEFAULT 'mist';
ALTER TABLE "DeviceToken" ADD COLUMN "channelSound" TEXT NOT NULL DEFAULT 'mist';
