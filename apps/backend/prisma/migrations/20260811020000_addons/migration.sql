-- Addons: a published manifest, and the servers that installed it.
--
-- Hand-written, minus the DROP INDEX "message_search_idx" that prisma migrate diff also emits
-- (that full-text index is raw SQL from an earlier migration and isn't in the Prisma schema).


-- CreateTable
CREATE TABLE "Addon" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300),
    "version" VARCHAR(32) NOT NULL,
    "manifest" JSONB NOT NULL,
    "authorId" TEXT,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerAddon" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "installedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Addon_slug_key" ON "Addon"("slug");

-- CreateIndex
CREATE INDEX "Addon_applicationId_idx" ON "Addon"("applicationId");

-- CreateIndex
CREATE INDEX "ServerAddon_serverId_enabled_idx" ON "ServerAddon"("serverId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ServerAddon_serverId_addonId_key" ON "ServerAddon"("serverId", "addonId");

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerAddon" ADD CONSTRAINT "ServerAddon_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerAddon" ADD CONSTRAINT "ServerAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerAddon" ADD CONSTRAINT "ServerAddon_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

