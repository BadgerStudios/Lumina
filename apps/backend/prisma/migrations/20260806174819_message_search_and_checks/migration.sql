-- Add a generated full-text search column for Message content, kept in sync
-- via trigger, plus a GIN index and a channel-XOR-dm integrity check.

ALTER TABLE "Message" ADD COLUMN "searchVector" tsvector;

CREATE FUNCTION message_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_search_vector_trigger
BEFORE INSERT OR UPDATE ON "Message"
FOR EACH ROW EXECUTE FUNCTION message_search_vector_update();

-- Backfill existing rows (none expected at this point in dev, but safe).
UPDATE "Message" SET "searchVector" = to_tsvector('english', coalesce(content, ''));

CREATE INDEX message_search_idx ON "Message" USING GIN ("searchVector");

ALTER TABLE "Message" ADD CONSTRAINT message_channel_or_dm_check CHECK (num_nonnulls("channelId", "dmConversationId") = 1);
