import type { RoleDTO, UserDTO } from "@lumina/shared";
import { useMembers, useAssignRole, useRevokeRole } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useServer } from "../../queries/servers";
import { useAuthStore } from "../../store/authStore";
import { can } from "../../lib/permissions";
import { reportError } from "../../store/toastStore";
import { UserProfileCard, type RoleManagement } from "./UserProfileCard";

/** Roles the viewer may hand out: below their own highest role (every role for the owner), never @everyone.
 * UX only — the server re-checks the hierarchy on every assignment. */
export function assignableRoles(roles: RoleDTO[] | undefined, myRoleIds: string[], isOwner: boolean): RoleDTO[] {
  if (!roles) return [];
  const mine = roles.filter((r) => myRoleIds.includes(r.id)).map((r) => r.position);
  const top = isOwner ? Number.POSITIVE_INFINITY : mine.length ? Math.max(...mine) : -1;
  return roles.filter((r) => !r.isDefault && r.position < top).sort((a, b) => b.position - a.position);
}

/**
 * The profile card with its space around it: nickname, roles, "in this space since", and role
 * editing for people allowed to manage roles. Clicking an author in chat used to open the bare
 * card, so none of that showed outside the member list. Without a serverId (a DM) it is the plain
 * card.
 */
export function ServerProfileCard({ user, serverId, onMessage }: { user: UserDTO; serverId?: string; onMessage?: () => void }) {
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  const { data: server } = useServer(serverId);
  const meId = useAuthStore((s) => s.user?.id);
  const assign = useAssignRole(serverId ?? "");
  const revoke = useRevokeRole(serverId ?? "");

  if (!serverId) return <UserProfileCard user={user} onMessage={onMessage} />;

  const member = members?.find((m) => m.userId === user.id);
  const me = members?.find((m) => m.userId === meId);
  const canManage = can("MANAGE_ROLES", { userId: meId, server, member: me, roles });
  const manageRoles: RoleManagement | undefined =
    canManage && member
      ? {
          assignable: assignableRoles(roles, me?.roleIds ?? [], server?.ownerId === meId),
          onAdd: (roleId) => assign.mutate({ userId: user.id, roleId }, { onError: (e) => reportError(e, "Couldn't add that role.") }),
          onRemove: (roleId) => revoke.mutate({ userId: user.id, roleId }, { onError: (e) => reportError(e, "Couldn't remove that role.") }),
          pending: assign.isPending || revoke.isPending,
        }
      : undefined;

  return (
    <UserProfileCard
      // The member list's copy of the user is the fresher one; presence comes from the caller, which
      // reads it live from the presence store.
      user={member ? { ...member.user, presence: user.presence } : user}
      nickname={member?.nickname}
      roles={roles}
      member={member}
      onMessage={onMessage}
      manageRoles={manageRoles}
    />
  );
}
