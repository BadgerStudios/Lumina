import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { MemberDTO, RoleDTO, ServerDTO } from "@lumina/shared";
import { useMembers } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useAuthStore } from "../../store/authStore";
import { can } from "../../lib/permissions";
import { UserAvatar } from "../common/UserAvatar";
import { BotBadge } from "../common/BotBadge";
import { MemberRolesMenu } from "../layout/MemberRoster";

/**
 * Members, as a settings section: everyone in the space, searchable and filterable by role, with
 * the same per-member menu the roster uses (roles, nickname, timeout, kick, ban). The roster is
 * for glancing while chatting; this is for working through a list — finding the ten people who
 * still hold a role you are retiring, or the account you need to remove now.
 */
export function ServerMembersPanel({ server, serverId }: { server: ServerDTO; serverId: string }) {
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");

  const me = members?.find((m) => m.userId === currentUserId);
  const ctx = { userId: currentUserId, server, member: me, roles };
  const canManageRoles = can("MANAGE_ROLES", ctx);
  const canTimeout = can("TIMEOUT_MEMBERS", ctx);
  const canKick = can("KICK_MEMBERS", ctx);
  const canBan = can("BAN_MEMBERS", ctx);
  const canManageNicknames = can("MANAGE_NICKNAMES", ctx);

  const roleById = useMemo(() => new Map((roles ?? []).map((r) => [r.id, r])), [roles]);
  const customRoles = useMemo(() => (roles ?? []).filter((r) => !r.isDefault).sort((a, b) => b.position - a.position), [roles]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => !roleFilter || m.roleIds.includes(roleFilter))
      .filter((m) => !q || [m.nickname, m.user.displayName, m.user.username].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  }, [members, query, roleFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-signal-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or username"
            aria-label="Search members"
            className="w-full rounded-lg border border-hairline bg-base-800 py-2 pl-9 pr-3 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
        </label>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="Filter by role"
          className="rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal focus:border-accent focus:outline-none"
        >
          <option value="">Every role</option>
          {customRoles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-signal-faint">
        {members ? `${shown.length} of ${members.length} member${members.length === 1 ? "" : "s"}` : "Loading members…"}
      </p>

      <ul className="flex flex-col gap-1">
        {shown.map((m) => {
          const timedOut = !!m.mutedUntil && new Date(m.mutedUntil) > new Date();
          const memberRoles = m.roleIds.map((id) => roleById.get(id)).filter((r): r is RoleDTO => !!r && !r.isDefault).sort((a, b) => b.position - a.position);
          return (
            <li key={m.userId} className="flex items-center gap-3 rounded-lg bg-base-900 px-3 py-2">
              <UserAvatar avatarUrl={m.user.avatarUrl} name={labelOf(m)} size={30} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-signal">{labelOf(m)}</span>
                  {m.user.isBot ? <BotBadge /> : null}
                  {m.userId === server.ownerId ? <span className="rounded bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">Owner</span> : null}
                  {timedOut ? <span className="rounded bg-dnd/15 px-1.5 text-[10px] font-semibold text-dnd">Timed out</span> : null}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-signal-faint">
                  <span className="truncate">@{m.user.username}</span>
                  <span>· joined {new Date(m.joinedAt).toLocaleDateString()}</span>
                  {memberRoles.slice(0, 4).map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: roleColor(r) }} aria-hidden />
                      {r.name}
                    </span>
                  ))}
                  {memberRoles.length > 4 ? <span>+{memberRoles.length - 4}</span> : null}
                </div>
              </div>
              {m.userId !== currentUserId && (canManageRoles || canTimeout || canKick || canBan || canManageNicknames) ? (
                <MemberRolesMenu
                  serverId={serverId}
                  member={m}
                  roles={roles ?? []}
                  canManageRoles={canManageRoles}
                  canTimeout={canTimeout}
                  canKick={canKick}
                  canBan={canBan}
                  canManageNicknames={canManageNicknames}
                />
              ) : null}
            </li>
          );
        })}
        {members && shown.length === 0 ? <li className="py-6 text-center text-sm text-signal-faint">Nobody matches.</li> : null}
      </ul>
    </div>
  );
}

function labelOf(m: MemberDTO): string {
  return m.nickname ?? m.user.displayName ?? m.user.username;
}

function roleColor(r: RoleDTO): string {
  return r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "var(--signal-faint)";
}
