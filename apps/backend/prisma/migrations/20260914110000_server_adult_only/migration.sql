-- 18+ spaces. Join-time only: an account known to be under 18 is refused entry, and anyone already
-- inside is untouched — ejecting existing members is a heavier decision than declining a join and
-- belongs to the space owner rather than to a column default.
--
-- Defaults to false so every existing space keeps behaving exactly as it does today, and enabling
-- it is always a deliberate choice.
ALTER TABLE "Server" ADD COLUMN "adultOnly" BOOLEAN NOT NULL DEFAULT false;
