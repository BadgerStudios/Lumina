import { prisma } from "../../db/prisma.js";
import { toSnowflake } from "./ids.js";
import { mapInvite, mapUser } from "./shapes.js";

/**
 * Invites across the Discord boundary, shared by the REST routes and the gateway's INVITE_CREATE /
 * INVITE_DELETE. A Lumina invite opens the whole space, so it points at the space's system channel
 * (or its first text channel) — the channel a Discord invite would name.
 */
export type InviteJson = {
  code: string;
  serverId: string;
  creatorId: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
};

export async function inviteContext(serverId: string) {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, name: true, description: true, systemChannelId: true },
  });
  const channel = server?.systemChannelId
    ? await prisma.channel.findUnique({ where: { id: server.systemChannelId }, select: { id: true, name: true } })
    : await prisma.channel.findFirst({ where: { serverId, type: "TEXT" }, orderBy: { position: "asc" }, select: { id: true, name: true } });
  return { server, channel };
}

export async function shapeInvite(inv: InviteJson, counts = false) {
  const { server, channel } = await inviteContext(inv.serverId);
  const inviter = await prisma.user.findUnique({ where: { id: inv.creatorId } });
  const members = counts ? await prisma.membership.count({ where: { serverId: inv.serverId } }) : undefined;
  return mapInvite(inv, server, channel, inviter, members);
}

/** Discord's INVITE_CREATE payload. */
export async function inviteCreateEvent(inv: InviteJson) {
  const { channel } = await inviteContext(inv.serverId);
  const inviter = await prisma.user.findUnique({ where: { id: inv.creatorId } });
  const created = Date.parse(inv.createdAt);
  const expires = inv.expiresAt ? Date.parse(inv.expiresAt) : null;
  return {
    channel_id: channel ? await toSnowflake("channel", channel.id) : "0",
    guild_id: await toSnowflake("guild", inv.serverId),
    code: inv.code,
    created_at: inv.createdAt,
    ...(inviter ? { inviter: await mapUser(inviter) } : {}),
    max_age: expires !== null && Number.isFinite(created) ? Math.max(0, Math.round((expires - created) / 1000)) : 0,
    max_uses: inv.maxUses ?? 0,
    temporary: false,
    uses: inv.uses,
  };
}

/** Discord's INVITE_DELETE payload. */
export async function inviteDeleteEvent(serverId: string, code: string) {
  const { channel } = await inviteContext(serverId);
  return {
    channel_id: channel ? await toSnowflake("channel", channel.id) : "0",
    guild_id: await toSnowflake("guild", serverId),
    code,
  };
}
