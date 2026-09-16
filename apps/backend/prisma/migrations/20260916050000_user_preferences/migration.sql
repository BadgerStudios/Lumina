-- Account preferences, one JSON blob per person (see modules/users/preferences.ts for the shape).
ALTER TABLE "User" ADD COLUMN "preferencesJson" JSONB;
