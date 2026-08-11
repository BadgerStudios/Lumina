import type { NotificationLevel } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

// See schema.prisma's NotificationOverride model comment for why this is "" and not null.
export const SERVER_LEVEL_CHANNEL = "";

/** Channel override -> server override -> global default (ALL, matches Discord's own default —
 * opt-out, not opt-in). Only ever two rows can apply to a given (userId, serverId, channelId):
 * the exact channel row and the server-wide ("" channelId) row, so this is a single query
 * rather than walking a hierarchy. */
export async function getEffectiveNotificationLevel(
  userId: string,
  serverId: string,
  channelId: string,
): Promise<NotificationLevel> {
  const rows = await prisma.notificationOverride.findMany({
    where: { userId, serverId, channelId: { in: [channelId, SERVER_LEVEL_CHANNEL] } },
  });
  const channelRow = rows.find((r) => r.channelId === channelId);
  if (channelRow) return channelRow.level;
  const serverRow = rows.find((r) => r.channelId === SERVER_LEVEL_CHANNEL);
  if (serverRow) return serverRow.level;
  return "ALL";
}

/** Whether a push notification should actually be sent. `isMention` is always true for the one
 * caller today (modules/messages/mentions.ts) — plain non-mention channel messages never push
 * at all regardless of level (matches Discord's default behavior, see roadmap memory), so ALL
 * vs MENTIONS has no observable difference yet. Both tiers are still stored/computed for real
 * rather than collapsed into a boolean, since a future "push for every message" feature would
 * need ALL to already mean something rather than retrofitting it later. */
export async function shouldNotify(userId: string, serverId: string, channelId: string, isMention: boolean): Promise<boolean> {
  const level = await getEffectiveNotificationLevel(userId, serverId, channelId);
  if (level === "NONE") return false;
  if (level === "MENTIONS") return isMention;
  return true;
}

export async function setNotificationOverride(params: {
  userId: string;
  serverId: string;
  channelId: string | null;
  level: NotificationLevel;
}): Promise<void> {
  const channelId = params.channelId ?? SERVER_LEVEL_CHANNEL;
  await prisma.notificationOverride.upsert({
    where: { userId_serverId_channelId: { userId: params.userId, serverId: params.serverId, channelId } },
    create: { userId: params.userId, serverId: params.serverId, channelId, level: params.level },
    update: { level: params.level },
  });
}

export async function getNotificationOverrides(userId: string, serverId: string) {
  return prisma.notificationOverride.findMany({ where: { userId, serverId } });
}
