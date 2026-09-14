-- What a server shows someone who has just arrived.
--
-- The single largest retention lever in the research: servers that put new members through a short
-- orientation before dropping them into the full channel list hold 43-67% of them through the first
-- week, against 12-18% without. The mechanism is not the welcome text — it is that answering two
-- questions gives someone roles, and roles give them a server that looks smaller than it is.

CREATE TABLE "ServerOnboarding" (
    "serverId"     TEXT NOT NULL,
    "enabled"      BOOLEAN NOT NULL DEFAULT false,
    "welcomeTitle" VARCHAR(120),
    "welcomeBody"  VARCHAR(1000),
    "rules"        VARCHAR(4000),
    -- When true, a member cannot post until they have accepted. Off by default: a gate nobody
    -- configured is a server that silently stops working.
    "requireRules" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerOnboarding_pkey" PRIMARY KEY ("serverId")
);

ALTER TABLE "ServerOnboarding" ADD CONSTRAINT "ServerOnboarding_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One question asked during onboarding.
CREATE TABLE "OnboardingPrompt" (
    "id"       TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "title"    VARCHAR(120) NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OnboardingPrompt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingPrompt_serverId_position_idx" ON "OnboardingPrompt"("serverId", "position");

ALTER TABLE "OnboardingPrompt" ADD CONSTRAINT "OnboardingPrompt_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "ServerOnboarding"("serverId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One answer, and the roles picking it grants.
--
-- roleIds is a scalar array rather than a join table: the list is short, always read whole with its
-- option, and never queried BY role. A join table would be three rows and a join to answer "what
-- does this button do".
CREATE TABLE "OnboardingOption" (
    "id"          TEXT NOT NULL,
    "promptId"    TEXT NOT NULL,
    "label"       VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "emoji"       VARCHAR(16),
    "roleIds"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "position"    INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OnboardingOption_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingOption_promptId_position_idx" ON "OnboardingOption"("promptId", "position");

ALTER TABLE "OnboardingOption" ADD CONSTRAINT "OnboardingOption_promptId_fkey"
  FOREIGN KEY ("promptId") REFERENCES "OnboardingPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Where a member is in all this.
--
-- On Membership rather than a table of its own: it is exactly one row per member per server, which
-- is what Membership already is, and it is read on the same query that already checks whether they
-- are muted — so the rules gate costs no extra round trip on the message path.
ALTER TABLE "Membership" ADD COLUMN "onboardedAt" TIMESTAMP(3);
ALTER TABLE "Membership" ADD COLUMN "rulesAcceptedAt" TIMESTAMP(3);
