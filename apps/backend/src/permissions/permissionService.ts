import { Permissions, combinePermissions } from "@lumina/shared";
import { prisma } from "../db/prisma.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

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
