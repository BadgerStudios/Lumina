-- Scheduled server events with RSVP. Additive only; hand-written per the documented workflow.

CREATE TYPE "EventRsvpStatus" AS ENUM ('GOING', 'INTERESTED');

ALTER TYPE "NotificationKind" ADD VALUE 'EVENT_REMINDER';

CREATE TABLE "ServerEvent" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "creatorId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channelId" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServerEvent_serverId_startsAt_idx" ON "ServerEvent"("serverId", "startsAt");
CREATE INDEX "ServerEvent_startsAt_idx" ON "ServerEvent"("startsAt");

ALTER TABLE "ServerEvent" ADD CONSTRAINT "ServerEvent_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServerEvent" ADD CONSTRAINT "ServerEvent_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServerEvent" ADD CONSTRAINT "ServerEvent_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServerEventRsvp" (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "EventRsvpStatus" NOT NULL DEFAULT 'GOING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerEventRsvp_pkey" PRIMARY KEY ("eventId", "userId")
);

CREATE INDEX "ServerEventRsvp_userId_idx" ON "ServerEventRsvp"("userId");

ALTER TABLE "ServerEventRsvp" ADD CONSTRAINT "ServerEventRsvp_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "ServerEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServerEventRsvp" ADD CONSTRAINT "ServerEventRsvp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
