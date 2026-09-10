-- Cleanup deletes overwrites by targetId; the existing composite leads with channelId
-- and so cannot serve that lookup.
CREATE INDEX "ChannelPermissionOverwrite_targetId_idx" ON "ChannelPermissionOverwrite"("targetId");
