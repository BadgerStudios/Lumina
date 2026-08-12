import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ShieldPlus, Check, Clock, X as XIcon, Pencil as PencilIcon, UserMinus as UserMinusIcon, Gavel as GavelIcon } from "lucide-react";
import { useMembers, useAssignRole, useRevokeRole, useKickMember, useUpdateMember } from "../../queries/members";
import { useRoles } from "../../queries/roles";
import { useServer } from "../../queries/servers";
import { useCreateDM } from "../../queries/dms";
import { useTimeoutMember, useBanMember } from "../../queries/moderation";
import { usePresenceStore } from "../../store/presenceStore";
import { reportError } from "../../store/toastStore";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { UserAvatar } from "../common/UserAvatar";
import { BotBadge } from "../common/BotBadge";
import { OfficialBadge } from "../common/OfficialBadge";
import { UserProfileCard } from "../common/UserProfileCard";
import { can } from "../../lib/permissions";
import { ApiError } from "../../lib/apiClient";
import { cn } from "../../lib/cn";
import type { MemberDTO, RoleDTO } from "@lumina/shared";

// Discord's own timeout duration ladder.
const TIMEOUT_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "60 seconds", seconds: 60 },
  { label: "5 minutes", seconds: 5 * 60 },
  { label: "10 minutes", seconds: 10 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "1 week", seconds: 7 * 24 * 60 * 60 },
];

function colorToCss(color: number | null): string | undefined {
  if (color === null) return undefined;
  return `#${color.toString(16).padStart(6, "0")}`;
}

function highestColoredRole(member: MemberDTO, roles: RoleDTO[]): RoleDTO | undefined {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const owned = member.roleIds.map((id) => roleById.get(id)).filter((r): r is RoleDTO => !!r && r.color !== null);
  if (owned.length === 0) return undefined;
  return owned.sort((a, b) => b.position - a.position)[0];
}

/**
 * Grants/revokes roles for one member — the backend endpoints (POST/DELETE
 * /servers/:id/members/:userId/roles/:roleId, see queries/members.ts's useAssignRole/
 * useRevokeRole) existed with no UI ever calling them; role hierarchy is enforced
 * server-side (checkRoleHierarchy in permissionService.ts) so a rejected toggle here just
 * surfaces that error rather than re-implementing the hierarchy check client-side.
 *
 * Also carries timeout controls — useTimeoutMember (queries/moderation.ts) and its backend
 * route (POST /servers/:id/timeout) were fully built and enforced (messages/service.ts blocks
 * sends from a timed-out member) with zero UI ever calling it, same bug class as the role
 * gap above.
 */
function MemberRolesMenu({
  serverId,
  member,
  roles,
  canManageRoles,
  canTimeout,
  canKick,
  canBan,
  canManageNicknames,
}: {
  serverId: string;
  member: MemberDTO;
  roles: RoleDTO[];
  canManageRoles: boolean;
  canTimeout: boolean;
  canKick: boolean;
  canBan: boolean;
  canManageNicknames: boolean;
}) {
  const assignRole = useAssignRole(serverId);
  const revokeRole = useRevokeRole(serverId);
  const timeoutMember = useTimeoutMember(serverId);
  const kickMember = useKickMember(serverId);
  const banMember = useBanMember(serverId);
  const updateMember = useUpdateMember(serverId);
  const [error, setError] = useState<string | null>(null);
  const assignableRoles = roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const label = member.nickname ?? member.user.displayName ?? member.user.username;
  const isTimedOut = !!member.mutedUntil && new Date(member.mutedUntil) > new Date();

  async function toggle(roleId: string, hasRole: boolean) {
    setError(null);
    try {
      if (hasRole) await revokeRole.mutateAsync({ userId: member.userId, roleId });
      else await assignRole.mutateAsync({ userId: member.userId, roleId });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update role");
    }
  }

  async function setTimeout_(seconds: number | null) {
    setError(null);
    try {
      const until = seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();
      await timeoutMember.mutateAsync({ userId: member.userId, until });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update timeout");
    }
  }

  // Kick and ban are the two irreversible-feeling actions in this menu, so both confirm. Ban
  // especially: it is the only one that also prevents them coming back.
  async function kick() {
    if (!window.confirm(`Remove ${label} from the server? They can rejoin with a new invite.`)) return;
    setError(null);
    try {
      await kickMember.mutateAsync(member.userId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to remove them");
    }
  }

  async function ban() {
    if (!window.confirm(`Ban ${label}? They'll be removed and can't rejoin until the ban is lifted.`)) return;
    setError(null);
    try {
      const reason = window.prompt("Reason (optional, shown in the audit log):") ?? undefined;
      await banMember.mutateAsync({ userId: member.userId, reason: reason || undefined });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to ban them");
    }
  }

  async function rename() {
    const next = window.prompt("Nickname in this server (leave empty to clear):", member.nickname ?? "");
    if (next === null) return;
    setError(null);
    try {
      await updateMember.mutateAsync({ userId: member.userId, nickname: next.trim() || null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to set a nickname");
    }
  }

  return (
    <DropdownMenu.Root onOpenChange={() => setError(null)}>
      <DropdownMenu.Trigger asChild>
        {/* Previously opacity-0 until row hover — real, reported discoverability bug: the only
            way to assign a role to a member was this icon, and it was functionally invisible
            unless you already knew to hover exactly here. Always visible now. */}
        <button
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-base-500 hover:text-signal",
            isTimedOut ? "text-dnd" : "text-signal-faint",
          )}
          title={isTimedOut ? "Manage member (timed out)" : "Manage member"}
          onClick={(e) => e.stopPropagation()}
        >
          {isTimedOut ? <Clock size={15} /> : <ShieldPlus size={15} />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="left" align="start" className="z-50 max-h-96 w-56 overflow-y-auto rounded-md bg-base-600 p-1.5 shadow-lg">
          {canManageRoles && (
            <>
              <div className="px-2 py-1 text-xs font-bold uppercase text-signal-dim">Roles</div>
              {assignableRoles.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-signal-faint">No custom roles yet.</div>
              ) : (
                assignableRoles.map((role) => {
                  const hasRole = member.roleIds.includes(role.id);
                  return (
                    <DropdownMenu.Item
                      key={role.id}
                      onSelect={(e) => {
                        e.preventDefault();
                        void toggle(role.id, hasRole);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {hasRole ? <Check size={14} className="text-online" /> : null}
                      </span>
                      <span className="truncate" style={{ color: colorToCss(role.color) }}>
                        {role.name}
                      </span>
                    </DropdownMenu.Item>
                  );
                })
              )}
            </>
          )}

          {canTimeout && (
            <>
              <div className={cn("px-2 py-1 text-xs font-bold uppercase text-signal-dim", canManageRoles && "mt-1 border-t border-base-900/60 pt-2")}>
                Timeout
              </div>
              {TIMEOUT_PRESETS.map((p) => (
                <DropdownMenu.Item
                  key={p.seconds}
                  onSelect={(e) => {
                    e.preventDefault();
                    void setTimeout_(p.seconds);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
                >
                  <Clock size={14} className="shrink-0 text-signal-faint" />
                  {p.label}
                </DropdownMenu.Item>
              ))}
              {isTimedOut && (
                <DropdownMenu.Item
                  onSelect={(e) => {
                    e.preventDefault();
                    void setTimeout_(null);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-dnd outline-none hover:bg-base-500"
                >
                  <XIcon size={14} className="shrink-0" />
                  Remove timeout
                </DropdownMenu.Item>
              )}
            </>
          )}

          {/* Kick and ban had fully-built backend routes and query hooks (useKickMember,
              useBanMember) that nothing ever called — the same "backend built, no UI" gap as roles
              and timeout before them. Without these the Bans tab in server settings could only
              ever list bans that were impossible to create. */}
          {(canManageNicknames || canKick || canBan) && (
            <div className={cn("px-2 py-1 text-xs font-bold uppercase text-signal-dim", (canManageRoles || canTimeout) && "mt-1 border-t border-base-900/60 pt-2")}>
              Manage
            </div>
          )}
          {canManageNicknames && (
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                void rename();
              }}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
            >
              <PencilIcon size={14} className="shrink-0 text-signal-faint" />
              {member.nickname ? "Change nickname" : "Set nickname"}
            </DropdownMenu.Item>
          )}
          {canKick && (
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                void kick();
              }}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-signal outline-none hover:bg-base-500"
            >
              <UserMinusIcon size={14} className="shrink-0 text-signal-faint" />
              Kick from server
            </DropdownMenu.Item>
          )}
          {canBan && (
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                void ban();
              }}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-dnd outline-none hover:bg-base-500"
            >
              <GavelIcon size={14} className="shrink-0" />
              Ban from server
            </DropdownMenu.Item>
          )}

          {error ? <div className="mt-1 border-t border-base-900/60 px-2 py-1.5 text-xs text-dnd">{error}</div> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Clicking a member previously either did nothing, or (earlier this session) jumped straight
 * to a DM — upgraded to a real Discord-style profile popover (bio/pronouns/banner, all fully
 * editable in UserSettingsModal.tsx but with no surface anywhere to actually SEE them on
 * another user until now) with a "Message" button inside it for the DM jump. */
function MemberRow({
  member,
  color,
  presence,
  isSelf,
  canManageRoles,
  canTimeout,
  canKick,
  canBan,
  canManageNicknames,
  serverId,
  roles,
  onMessage,
}: {
  member: MemberDTO;
  color?: string;
  presence: MemberDTO["user"]["presence"];
  isSelf: boolean;
  canManageRoles: boolean;
  canTimeout: boolean;
  canKick: boolean;
  canBan: boolean;
  canManageNicknames: boolean;
  serverId: string;
  roles: RoleDTO[];
  onMessage: (userId: string) => void;
}) {
  const label = member.nickname ?? member.user.displayName ?? member.user.username;
  return (
    <div className="group flex items-center gap-2.5 rounded px-2 py-1.5 hover:bg-base-600">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            <UserAvatar avatarUrl={member.user.avatarUrl} name={label} size={32} presence={presence} />
            <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium" style={{ color }}>
              <span className="truncate">{label}</span>
              {member.user.isOfficial ? <OfficialBadge compact /> : null}
              {member.user.isBot ? <BotBadge /> : null}
            </span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="left" align="start" className="z-50">
            <UserProfileCard
              user={{ ...member.user, presence }}
              nickname={member.nickname}
              onMessage={!isSelf && !member.user.isBot ? () => onMessage(member.userId) : undefined}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {canManageRoles || canTimeout || canKick || canBan || canManageNicknames ? (
        <MemberRolesMenu
          serverId={serverId}
          member={member}
          roles={roles}
          canManageRoles={canManageRoles}
          canTimeout={canTimeout}
          canKick={canKick}
          canBan={canBan}
          canManageNicknames={canManageNicknames}
        />
      ) : null}
    </div>
  );
}

export function MemberList({ serverId }: { serverId: string }) {
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);
  const { data: server } = useServer(serverId);
  const presenceByUserId = usePresenceStore((s) => s.presenceByUserId);
  const closeMemberList = useUIStore((s) => s.toggleMemberList);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const me = members?.find((m) => m.userId === currentUserId);
  const canManageRoles = can("MANAGE_ROLES", { userId: currentUserId, server, member: me, roles });
  const canTimeout = can("TIMEOUT_MEMBERS", { userId: currentUserId, server, member: me, roles });
  const canKick = can("KICK_MEMBERS", { userId: currentUserId, server, member: me, roles });
  const canBan = can("BAN_MEMBERS", { userId: currentUserId, server, member: me, roles });
  const canManageNicknames = can("MANAGE_NICKNAMES", { userId: currentUserId, server, member: me, roles });
  const createDM = useCreateDM();
  const navigate = useNavigate();

  // There was previously NO way to message a fellow server member short of already being
  // friends with them via the /friends page — clicking a name/avatar here did nothing at all.
  // Mirrors FriendsPane.tsx's openDM: creates (or resolves the existing) 1:1 DM and navigates
  // straight to it. Bots have no inbox worth opening a DM with.
  async function openDM(userId: string) {
    if (userId === currentUserId) return;
    try {
      const convo = await createDM.mutateAsync({ participantIds: [userId] });
      navigate(`/dm/${convo.id}`);
    } catch (e) {
      reportError(e, "Couldn't open a conversation with them.");
    }
  }

  const groups = useMemo(() => {
    if (!members) return [];
    const rolesSorted = [...(roles ?? [])].sort((a, b) => b.position - a.position);
    const online = members.filter((m) => (presenceByUserId[m.userId] ?? m.user.presence) !== "OFFLINE");
    const offline = members.filter((m) => (presenceByUserId[m.userId] ?? m.user.presence) === "OFFLINE");

    const byRole = new Map<string, MemberDTO[]>();
    const noRole: MemberDTO[] = [];
    for (const m of online) {
      const role = highestColoredRole(m, roles ?? []);
      if (!role) {
        noRole.push(m);
        continue;
      }
      const list = byRole.get(role.id) ?? [];
      list.push(m);
      byRole.set(role.id, list);
    }

    const result: Array<{ label: string; color?: string; members: MemberDTO[] }> = [];
    for (const role of rolesSorted) {
      const list = byRole.get(role.id);
      if (list?.length) result.push({ label: role.name, color: colorToCss(role.color), members: list });
    }
    if (noRole.length) result.push({ label: "Online", members: noRole });
    if (offline.length) result.push({ label: "Offline", members: offline });
    return result;
  }, [members, roles, presenceByUserId]);

  return (
    <>
      <div className="mobile-drawer-backdrop fixed inset-0 z-30 md:hidden" onClick={closeMemberList} />
      <div
        className={cn(
          "flex h-full w-60 shrink-0 flex-col overflow-y-auto bg-base-800 px-2 py-3",
          "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-2xl",
        )}
      >
      {groups.map((group) => (
        <div key={group.label} className="mb-4">
          <div className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-signal-dim">
            {group.label} — {group.members.length}
          </div>
          <div className="flex flex-col gap-0.5">
            {group.members
              .sort((a, b) => (a.nickname ?? a.user.displayName ?? a.user.username).localeCompare(b.nickname ?? b.user.displayName ?? b.user.username))
              .map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  color={group.color}
                  presence={presenceByUserId[m.userId] ?? m.user.presence}
                  isSelf={m.userId === currentUserId}
                  canManageRoles={canManageRoles}
                  canTimeout={canTimeout && m.userId !== currentUserId}
                  // Never offered against yourself: the server rejects it anyway, and a menu item
                  // that exists only to fail is worse than no menu item.
                  canKick={canKick && m.userId !== currentUserId}
                  canBan={canBan && m.userId !== currentUserId}
                  canManageNicknames={canManageNicknames}
                  serverId={serverId}
                  roles={roles ?? []}
                  onMessage={(userId) => void openDM(userId)}
                />
              ))}
          </div>
        </div>
      ))}
      </div>
    </>
  );
}
