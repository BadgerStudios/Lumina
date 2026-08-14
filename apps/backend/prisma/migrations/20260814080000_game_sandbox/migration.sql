-- User-hosted programmable game sandboxes. Lumina is the control plane; the untrusted container
-- runs on the OWNER's machine via a Lumina Game Agent. Additive only.
CREATE TYPE "SandboxStatus" AS ENUM ('OFFLINE', 'STARTING', 'ONLINE', 'STOPPING', 'ERROR');

CREATE TABLE "GameSandbox" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'minecraft',
    "agentTokenHash" TEXT,
    "status" "SandboxStatus" NOT NULL DEFAULT 'OFFLINE',
    "specJson" JSONB,
    "connectAddress" TEXT,
    "playerCount" INTEGER NOT NULL DEFAULT 0,
    "maxPlayers" INTEGER NOT NULL DEFAULT 0,
    "consoleTail" TEXT,
    "pendingCommand" TEXT,
    "serverId" TEXT,
    "hostedByLumina" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GameSandbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GameSandbox_agentTokenHash_key" ON "GameSandbox"("agentTokenHash");
CREATE INDEX "GameSandbox_ownerId_idx" ON "GameSandbox"("ownerId");
CREATE INDEX "GameSandbox_serverId_idx" ON "GameSandbox"("serverId");
ALTER TABLE "GameSandbox" ADD CONSTRAINT "GameSandbox_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameSandbox" ADD CONSTRAINT "GameSandbox_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;
