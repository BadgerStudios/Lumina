-- System messages: a message row can now be a join/leave announcement rather than something a
-- person typed. Rendered differently by clients; type 7 (GUILD_MEMBER_JOIN) on the Discord side.
CREATE TYPE "MessageType" AS ENUM ('DEFAULT', 'MEMBER_JOIN', 'MEMBER_LEAVE');
ALTER TABLE "Message" ADD COLUMN "type" "MessageType" NOT NULL DEFAULT 'DEFAULT';

-- Per-space wording for those announcements; null means the built-in line.
ALTER TABLE "Server" ADD COLUMN "joinMessageTemplate" TEXT,
                     ADD COLUMN "leaveMessageTemplate" TEXT;

-- Subcommands: the path below the command name ("level" → ["rank"], or ["settings", "set"]).
ALTER TABLE "Interaction" ADD COLUMN "commandPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- New message ids are Discord-layout snowflakes (42 bits of ms since 2015-01-01, 10 zero bits,
-- 12-bit sequence). Bot libraries read a message's creation time off its id — cooldowns, "how old
-- is this", expiry — and sequential ids all decoded to January 2015. Existing ids are untouched:
-- every new id is larger than every old one, so ordering and cursor pagination still hold.
CREATE SEQUENCE IF NOT EXISTS "lumina_snowflake_seq" MINVALUE 0 MAXVALUE 4095 START WITH 0 CYCLE;
CREATE OR REPLACE FUNCTION lumina_snowflake() RETURNS BIGINT LANGUAGE SQL VOLATILE AS $$
  SELECT ((((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT) - 1420070400000) << 22)
         | nextval('lumina_snowflake_seq');
$$;
ALTER TABLE "Message" ALTER COLUMN "id" SET DEFAULT lumina_snowflake();
