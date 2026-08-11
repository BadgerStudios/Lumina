// Thin client-side wrapper around @lumina/shared's hasPermission. This is UX ONLY —
// it decides which buttons/menu items to show. The backend independently re-checks
// every permission on every mutation; hiding a button here never substitutes for
// that server-side enforcement, and a 403 from the API must always be surfaced to
// the user rather than "fixed" with more client logic.
import { Permissions, hasPermission, combinePermissions, type PermissionKey } from "@lumina/shared";
import type { MemberDTO, RoleDTO, ServerDTO } from "@lumina/shared";

export { Permissions };

/** Effective bitfield for a member = OR of every role they hold (roleIds) + the @everyone role. */
export function computeEffectivePermissions(member: MemberDTO | undefined, roles: RoleDTO[] | undefined): bigint {
  if (!member || !roles) return 0n;
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const bits: bigint[] = [];
  for (const roleId of member.roleIds) {
    const role = roleById.get(roleId);
    if (role) bits.push(BigInt(role.permissions));
  }
  const everyone = roles.find((r) => r.isDefault);
  if (everyone) bits.push(BigInt(everyone.permissions));
  return combinePermissions(bits);
}

export function can(
  permissionKey: PermissionKey,
  opts: { userId: string | undefined; server: ServerDTO | undefined; member: MemberDTO | undefined; roles: RoleDTO[] | undefined },
): boolean {
  const { userId, server, member, roles } = opts;
  if (!userId) return false;
  if (server && server.ownerId === userId) return true;
  const effective = computeEffectivePermissions(member, roles);
  return hasPermission(effective, Permissions[permissionKey]);
}
