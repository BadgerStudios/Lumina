-- AutoMod: per-server keyword rules.
--
-- HAND-WRITTEN, same reason as every migration here: `prisma migrate diff` leads with
-- `DROP INDEX "message_search_idx"` because that GIN index was created by raw SQL and is absent
-- from schema.prisma. Applying generated SQL verbatim deletes message search.

CREATE TABLE "AutoModRule" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "wholeWord" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "exemptRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoModRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoModTerm" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "term" VARCHAR(120) NOT NULL,

    CONSTRAINT "AutoModTerm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoModRule_serverId_enabled_idx" ON "AutoModRule"("serverId", "enabled");
CREATE INDEX "AutoModTerm_ruleId_idx" ON "AutoModTerm"("ruleId");

ALTER TABLE "AutoModRule" ADD CONSTRAINT "AutoModRule_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoModTerm" ADD CONSTRAINT "AutoModTerm_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AutoModRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
