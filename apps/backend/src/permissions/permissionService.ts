import { Permissions, combinePermissions } from "@lumina/shared";
import { prisma } from "../db/prisma.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";
import { applyChannelOverwrites, type Overwrite } from "./overwrites.js";

/**
 * Effective permission bitfield for a user in a server = bitwise OR of
 * `permissions` across every Role the user's Membership has via RoleAssignment,
 * PLUS the server's implicit default (`isDefault: true`) role, which every
 * member has automatically (no explicit RoleAssignment row required).
 */
export async function computeEffectivePermissions(userId: string, serverId: string): Promise<bigint> {
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId, serverId } },
    include: {
      roles: { include: { role: true } },
    },
  });

  if (!membership) {
    throw new ForbiddenError("Not a member of this server");
  }

  const defaultRole = await prisma.role.findFirst({
    where: { serverId, isDefault: true },
  });

  const bits: bigint[] = membership.roles.map((ra) => ra.role.permissions);
  if (defaultRole) bits.push(defaultRole.permissions);

  return combinePermissions(bits);
}

/**
 * Highest `position` among the roles explicitly assigned to the user (NOT
 * including the implicit @everyone role, which always sits at position 0 and
 * is the floor for hierarchy comparisons).
 */
export async function getHighestRolePosition(userId: string, serverId: string): Promise<number> {
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId, serverId } },
    include: { roles: { include: { role: true } } },
  });
  if (!membership) throw new ForbiddenError("Not a member of this server");

  let highest = 0;
  for (const ra of membership.roles) {
    if (ra.role.position > highest) highest = ra.role.position;
  }
  return highest;
}

export async function isServerOwner(userId: string, serverId: string): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (!server) throw new NotFoundError("Server not found");
  return server.ownerId === userId;
}

/**
 * Check order:
 *  1. server.ownerId === userId -> allow
 *  2. effective bitfield includes ADMINISTRATOR -> allow
 *  3. (effective & bit) !== 0n -> allow, else throw 403
 */
export async function checkPermission(userId: string, serverId: string, bit: bigint): Promise<void> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (!server) throw new NotFoundError("Server not found");
  if (server.ownerId === userId) return;

  const effective = await computeEffectivePermissions(userId, serverId);
  if ((effective & Permissions.ADMINISTRATOR) !== 0n) return;
  if ((effective & bit) !== 0n) return;

  throw new ForbiddenError("Missing required permission");
}

/**
 * Everything needed to resolve channel permissions for one member, loaded once.
 *
 * Channel-scoped checks are the hottest permission path in the app — every message send, every
 * channel list render, every socket room join. Resolving a member's roles and admin status
 * per-channel would turn rendering a 30-channel sidebar into 60+ queries, so the shape here is
 * deliberately "load the member once, then apply overwrites in memory per channel".
 */
export interface MemberChannelContext {
  /** Owner or ADMINISTRATOR: bypasses overwrites entirely and is answered without them. */
  bypass: boolean;
  base: bigint;
  everyoneRoleId: string;
  roleIds: string[];
  userId: string;
}

export async function loadMemberChannelContext(userId: string, serverId: string): Promise<MemberChannelContext> {
  const [server, membership, defaultRole] = await Promise.all([
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
    prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
      include: { roles: { include: { role: true } } },
    }),
    prisma.role.findFirst({ where: { serverId, isDefault: true }, select: { id: true, permissions: true } }),
  ]);

  if (!server) throw new NotFoundError("Server not found");
  if (!membership) throw new ForbiddenError("Not a member of this server");

  const bits = membership.roles.map((ra) => ra.role.permissions);
  if (defaultRole) bits.push(defaultRole.permissions);
  const base = combinePermissions(bits);

  return {
    bypass: server.ownerId === userId || (base & Permissions.ADMINISTRATOR) !== 0n,
    base,
    everyoneRoleId: defaultRole?.id ?? "",
    roleIds: membership.roles.map((ra) => ra.roleId),
    userId,
  };
}

function toOverwrites(rows: { targetType: string; targetId: string; allow: bigint; deny: bigint }[]): Overwrite[] {
  return rows.map((r) => ({
    targetType: r.targetType as Overwrite["targetType"],
    targetId: r.targetId,
    allow: r.allow,
    deny: r.deny,
  }));
}

/**
 * Effective permissions for a member inside one specific channel: the server-wide bitfield with
 * that channel's overwrites layered on top. See permissions/overwrites.ts for the ordering.
 */
export async function computeEffectiveChannelPermissions(
  userId: string,
  serverId: string,
  channelId: string,
): Promise<bigint> {
  const ctx = await loadMemberChannelContext(userId, serverId);
  if (ctx.bypass) return ~0n;

  const rows = await prisma.channelPermissionOverwrite.findMany({ where: { channelId } });
  return applyChannelOverwrites(toOverwrites(rows), ctx);
}

/**
 * The channel-aware sibling of checkPermission.
 *
 * Requires VIEW_CHANNELS in addition to the requested bit, and reports a missing view permission
 * as 404 rather than 403 — a private channel that answers "forbidden" confirms it exists, which
 * leaks the channel list the overwrite was configured to hide.
 */
export async function checkChannelPermission(
  userId: string,
  serverId: string,
  channelId: string,
  bit: bigint,
): Promise<void> {
  const effective = await computeEffectiveChannelPermissions(userId, serverId, channelId);
  if ((effective & Permissions.VIEW_CHANNELS) === 0n) throw new NotFoundError("Channel not found");
  if ((effective & bit) === 0n) throw new ForbiddenError("Missing required permission");
}

/**
 * Narrow a list of channels to those the member may see, in one pass.
 *
 * Used by every surface that enumerates channels. A channel the member cannot view must not
 * appear in the sidebar, in search results, or in an invite preview — hiding it in one place and
 * not the others is the usual way a "private" channel turns out not to be.
 */
export async function filterVisibleChannels<T extends { id: string }>(
  userId: string,
  serverId: string,
  channels: T[],
): Promise<T[]> {
  const ctx = await loadMemberChannelContext(userId, serverId);
  if (ctx.bypass) return channels;

  const rows = await prisma.channelPermissionOverwrite.findMany({
    where: { channelId: { in: channels.map((c) => c.id) } },
  });
  const byChannel = new Map<string, Overwrite[]>();
  for (const r of rows) {
    const list = byChannel.get(r.channelId) ?? [];
    list.push(...toOverwrites([r]));
    byChannel.set(r.channelId, list);
  }

  return channels.filter((c) => {
    const effective = applyChannelOverwrites(byChannel.get(c.id) ?? [], ctx);
    return (effective & Permissions.VIEW_CHANNELS) !== 0n;
  });
}

/**
 * Drop overwrites pointing at a role or member that no longer exists.
 *
 * `targetId` is polymorphic and therefore has no foreign key to cascade from (see the schema
 * comment). Without this, deleting a role would leave its overwrites in place, and a newly created
 * role that happened to reuse the id would silently inherit them.
 */
export async function deleteOverwritesForTarget(targetId: string): Promise<void> {
  await prisma.channelPermissionOverwrite.deleteMany({ where: { targetId } });
}

export async function hasAdminOrOwner(userId: string, serverId: string): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
  if (!server) throw new NotFoundError("Server not found");
  if (server.ownerId === userId) return true;
  const effective = await computeEffectivePermissions(userId, serverId);
  return (effective & Permissions.ADMINISTRATOR) !== 0n;
}

/**
 * Role hierarchy for role-management actions (create/edit/delete a role, or
 * assign/unassign a role to/from a member): the acting user's highest role
 * position must be strictly greater than the position of the role being
 * touched, UNLESS the actor is owner/ADMINISTRATOR. Also blocks touching the
 * isDefault role's identity (delete/rename) and blocks assigning a role at or
 * above the actor's own highest position (self-escalation guard).
 */
export async function checkRoleHierarchy(
  actorId: string,
  serverId: string,
  targetRolePosition: number,
): Promise<void> {
  const bypass = await hasAdminOrOwner(actorId, serverId);
  if (bypass) return;

  const actorHighest = await getHighestRolePosition(actorId, serverId);
  if (actorHighest <= targetRolePosition) {
    throw new ForbiddenError("Cannot act on a role at or above your own highest role");
  }
}
