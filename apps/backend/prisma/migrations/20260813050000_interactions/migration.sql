-- Slash commands and message components. Hand-written; see the stickers migration for why the
-- differ's output is never pasted verbatim (it opens by dropping the message-search index).

CREATE TYPE "InteractionType" AS ENUM ('COMMAND', 'COMPONENT');
CREATE TYPE "InteractionStatus" AS ENUM ('PENDING', 'RESPONDED', 'TIMED_OUT');

CREATE TABLE "SlashCommand" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "optionsJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlashCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" "InteractionType" NOT NULL,
    "status" "InteractionStatus" NOT NULL DEFAULT 'PENDING',
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "dmConversationId" TEXT,
    "serverId" TEXT,
    "commandName" TEXT,
    "optionsJson" JSONB,
    "componentCustomId" TEXT,
    "messageId" BIGINT,
    "token" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlashCommand_applicationId_idx" ON "SlashCommand"("applicationId");
CREATE UNIQUE INDEX "SlashCommand_applicationId_name_key" ON "SlashCommand"("applicationId", "name");
CREATE UNIQUE INDEX "Interaction_token_key" ON "Interaction"("token");
CREATE INDEX "Interaction_applicationId_createdAt_idx" ON "Interaction"("applicationId", "createdAt");
CREATE INDEX "Interaction_status_createdAt_idx" ON "Interaction"("status", "createdAt");

ALTER TABLE "SlashCommand" ADD CONSTRAINT "SlashCommand_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No FK to Channel/Message from Interaction on purpose: an interaction is an audit trail of
-- something a user did, and it has to survive the message being deleted mid-flight.
ALTER TABLE "Message" ADD COLUMN "componentsJson" JSONB;
