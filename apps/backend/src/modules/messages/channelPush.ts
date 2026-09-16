import { prisma } from "../../db/prisma.js";
import { sendPushToUser } from "../../lib/push.js";
import { activeUserIdsInServer } from "../../realtime/io.js";
import { filterVisibleChannels } from "../../permissions/permissionService.js";
import { effectiveLevelsForServer } from "../notifications/service.js";

/** Past this many people, a message in a space is a broadcast, not a conversation: the rest see it in the app. */
const MAX_RECIPIENTS = 300;
/** One push per person per channel per this many seconds; the notification updates in place (same tag). */
const PER_CHANNEL_COOLDOWN_S = 45;

/**
 * The push for an ordinary channel message — what "All messages" in a space's (or a member's own)
 * notification setting means. Goes to members whose level resolves to ALL, who were not already
 * pinged as a mention, who are not in the app right now, and who can see the channel. Fire-and-forget:
 * the author's send never waits on any of it.
 */
export async function pushChannelMessage(params: {
  serverId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  content: string;
  alreadyNotified: Set<string>;
}): Promise<void> {
  const members = await prisma.membership.findMany({ where: { serverId: params.serverId }, select: { userId: true } });
  const candidates = members.map((m) => m.userId).filter((id) => id !== params.authorId && !params.alreadyNotified.has(id));
  if (candidates.length === 0) return;
  const levels = await effectiveLevelsForServer(params.serverId, params.channelId, candidates);
  const following = candidates.filter((id) => levels.get(id) === "ALL");
  if (following.length === 0) return;
  // People with the app open see the channel light up on its own; a push on top is the noise everyone
  // learns to switch off. (Phones count here too: a foreground app shows the message live.)
  const active = await activeUserIdsInServer(params.serverId);
  const recipients = following.filter((id) => !active.has(id)).slice(0, MAX_RECIPIENTS);
  if (recipients.length === 0) return;
  const server = await prisma.server.findUnique({ where: { id: params.serverId }, select: { name: true } });
  const title = `#${params.channelName} \u00b7 ${server?.name ?? "Lumina"}`;
  const body = `${params.authorName}: ${params.content.slice(0, 140) || "sent an attachment"}`;
  // Loaded here rather than at module level so importing this file (tests, tooling) never opens a Redis connection.
  const { redis } = await import("../../db/redis.js");
  for (let i = 0; i < recipients.length; i += 25) {
    await Promise.all(
      recipients.slice(i, i + 25).map(async (userId) => {
        const fresh = await redis.set(`push:chan:${userId}:${params.channelId}`, "1", "EX", PER_CHANNEL_COOLDOWN_S, "NX");
        if (fresh !== "OK") return;
        const visible = await filterVisibleChannels(userId, params.serverId, [{ id: params.channelId }]);
        if (visible.length === 0) return;
        await sendPushToUser(userId, {
          title,
          body,
          url: `/channels/${params.serverId}/${params.channelId}`,
          tag: `channel-${params.channelId}`,
          kind: "message",
        });
      }),
    );
  }
}
