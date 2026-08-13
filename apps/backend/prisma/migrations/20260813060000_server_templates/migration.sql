-- Server templates. Hand-written; see the stickers migration for why the differ's output is never
-- pasted verbatim (it opens by dropping the message-search index).

CREATE TABLE "ServerTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "creatorId" TEXT,
    "sourceServerId" TEXT,
    "snapshotJson" JSONB NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServerTemplate_code_key" ON "ServerTemplate"("code");
CREATE INDEX "ServerTemplate_creatorId_idx" ON "ServerTemplate"("creatorId");
CREATE INDEX "ServerTemplate_sourceServerId_idx" ON "ServerTemplate"("sourceServerId");

-- Both SET NULL: the snapshot is meant to outlive the server it was taken from and the account
-- that took it. That is the entire reason the structure lives in JSON rather than as a relational
-- copy of Channel/Role rows.
ALTER TABLE "ServerTemplate" ADD CONSTRAINT "ServerTemplate_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServerTemplate" ADD CONSTRAINT "ServerTemplate_sourceServerId_fkey" FOREIGN KEY ("sourceServerId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;
