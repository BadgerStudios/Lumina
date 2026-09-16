import type { NotificationLevel } from "@prisma/client";
import { prisma } from "../../db/prisma.js";

// See schema.prisma's NotificationOverride model comment for why this is "" and not null.
export const SERVER_LEVEL_CHANNEL = "";

/** Channel override -> server override -> the space's own default (Space settings → Community →
 * "Default notifications", ALL unless changed). Only ever two rows can apply to a given
 * (userId, serverId, channelId): the exact channel row and the server-wide ("" channelId) row. */
export async function getEffectiveNotificationLevel(
  userId: string,
  serverId: string,
  channelId: string,
): Promise<NotificationLevel> {
  const levels = await effectiveLevelsForServer(serverId, channelId, [userId]);
  return levels.get(userId) ?? "ALL";
}

/** The same resolution for many members at once — one query for the overrides, one for the space default. */
export async function effectiveLevelsForServer(
  serverId: string,
  channelId: string,
  userIds: string[],
): Promise<Map<string, NotificationLevel>> {
  const out = new Map<string, NotificationLevel>();
  if (userIds.length === 0) return out;
  const [rows, server] = await Promise.all([
    prisma.notificationOverride.findMany({
      where: { serverId, userId: { in: userIds }, channelId: { in: [channelId, SERVER_LEVEL_CHANNEL] } },
    }),
    prisma.server.findUnique({ where: { id: serverId }, select: { defaultNotificationLevel: true } }),
  ]);
  const fallback: NotificationLevel = server?.defaultNotificationLevel ?? "ALL";
  const byUser = new Map<string, { channel?: NotificationLevel; server?: NotificationLevel }>();
  for (const r of rows) {
    const slot = byUser.get(r.userId) ?? {};
    if (r.channelId === channelId) slot.channel = r.level;
    else slot.server = r.level;
    byUser.set(r.userId, slot);
  }
  for (const id of userIds) {
    const slot = byUser.get(id);
    out.set(id, slot?.channel ?? slot?.server ?? fallback);
  }
  return out;
}

/** Whether a push notification should actually be sent. Mentions and replies pass `isMention`
 * (they push at ALL and MENTIONS); plain channel messages are pushed by
 * modules/messages/channelPush.ts to members whose level resolves to ALL. */
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
