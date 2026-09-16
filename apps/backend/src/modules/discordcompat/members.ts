import { prisma } from "../../db/prisma.js";
import { toSnowflake } from "./ids.js";

/**
 * The role snowflakes a member holds, @everyone excluded (Discord never lists it on a member — its id
 * is the guild's). Libraries compute a member's permissions from exactly this list, so an empty one
 * made every bot believe it had only @everyone's permissions: NadekoBot's `.prune 5` failed its
 * Manage Messages check and silently fell back to "prune my own messages", deleting nothing.
 */
export async function memberRoleSnowflakes(userId: string, serverId: string): Promise<string[]> {
  const rows = await prisma.roleAssignment.findMany({
    where: { membership: { userId, serverId }, role: { isDefault: false } },
    select: { roleId: true },
  });
  return Promise.all(rows.map((r) => toSnowflake("role", r.roleId)));
}

/** The same for many members of one space at once (member lists), one query. */
export async function memberRoleSnowflakesBulk(serverId: string, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of userIds) out.set(id, []);
  if (userIds.length === 0) return out;
  const rows = await prisma.roleAssignment.findMany({
    where: { membership: { serverId, userId: { in: userIds } }, role: { isDefault: false } },
    select: { roleId: true, membership: { select: { userId: true } } },
  });
  for (const r of rows) out.get(r.membership.userId)?.push(await toSnowflake("role", r.roleId));
  return out;
}
