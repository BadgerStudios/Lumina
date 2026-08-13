import { useState } from "react";
import { Trophy, Trash2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal } from "./Modal";
import { api } from "../../lib/apiClient";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../common/UserAvatar";
import { useRoles } from "../../queries/roles";
import { useUIStore } from "../../store/uiStore";
import { useServer } from "../../queries/servers";
import { useAuthStore } from "../../store/authStore";
import { can } from "../../lib/permissions";
import { useMembers } from "../../queries/members";

interface BoardRow { rank: number; userId: string; username: string; displayName: string | null; avatarUrl: string | null; xp: number; level: number }
interface Board { top: BoardRow[]; me: { rank: number | null; xp: number; level: number } | null; nextLevelXp: number }
interface Reward { id: string; level: number; role: { id: string; name: string; color: number | null } }

/**
 * Server leaderboard + level-reward configuration in one surface. Levels rank participation on a
 * spam-proof cooldown; rewards are ordinary roles granted automatically at a level — the native
 * version of the thing Discord communities install Mee6 for.
 */
export function LeaderboardModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "leaderboard" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";

  const user = useAuthStore((s) => s.user);
  const { data: server } = useServer(open ? serverId : undefined);
  const { data: members } = useMembers(open ? serverId : undefined);
  const { data: roles } = useRoles(open ? serverId : undefined);
  const me = members?.find((m) => m.userId === user?.id);
  const canManage = can("MANAGE_ROLES", { userId: user?.id, server, member: me, roles });

  const { data: board } = useQuery({
    queryKey: ["leaderboard", serverId],
    queryFn: () => api.get<Board>(`/servers/${serverId}/leaderboard`),
    enabled: open,
  });
  const { data: rewards } = useQuery({
    queryKey: ["levelRewards", serverId],
    queryFn: () => api.get<Reward[]>(`/servers/${serverId}/level-rewards`),
    enabled: open,
  });
  const queryClient = useQueryClient();
  const addReward = useMutation({
    mutationFn: (body: { level: number; roleId: string }) => api.post(`/servers/${serverId}/level-rewards`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["levelRewards", serverId] }),
  });
  const removeReward = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${serverId}/level-rewards/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["levelRewards", serverId] }),
  });

  const [rewardLevel, setRewardLevel] = useState(5);
  const [rewardRole, setRewardRole] = useState("");
  const assignableRoles = (roles ?? []).filter((r) => !r.isDefault);

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Leaderboard" width="max-w-lg">
      <div className="flex flex-col gap-4">
        {board?.me && (
          <div className="flex items-center gap-3 rounded-xl bg-accent/10 px-3 py-2 ring-1 ring-accent/40">
            <Trophy size={18} className="shrink-0 text-accent" />
            <span className="flex-1 text-sm text-signal">
              You're <span className="font-bold">level {board.me.level}</span>
              {board.me.rank ? ` — rank #${board.me.rank}` : ""}
            </span>
            <span className="text-xs text-signal-faint">{board.me.xp} XP</span>
          </div>
        )}

        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {(board?.top ?? []).map((row) => (
            <div key={row.userId} className="flex items-center gap-2.5 rounded-lg bg-base-900 px-3 py-1.5">
              <span className={cn("w-6 shrink-0 text-center text-sm font-bold", row.rank <= 3 ? "text-accent" : "text-signal-faint")}>
                {row.rank}
              </span>
              <UserAvatar avatarUrl={row.avatarUrl} name={row.username} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm text-signal">{row.displayName ?? row.username}</span>
              <span className="shrink-0 rounded bg-base-600 px-1.5 py-0.5 text-[10px] font-semibold text-signal">
                lvl {row.level}
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-signal-faint">{row.xp} XP</span>
            </div>
          ))}
          {board && board.top.length === 0 && (
            <p className="py-6 text-center text-sm text-signal-faint">No activity yet — levels grow from conversation.</p>
          )}
        </div>

        {canManage && (
          <div className="border-t border-base-700 pt-3">
            <p className="text-xs font-bold uppercase text-signal-dim">Level rewards</p>
            <p className="mb-2 mt-0.5 text-xs text-signal-faint">
              Grant a role automatically when a member reaches a level.
            </p>
            {(rewards ?? []).map((r) => (
              <div key={r.id} className="mb-1 flex items-center gap-2 rounded bg-base-900 px-2.5 py-1.5 text-sm">
                <span className="text-signal">Level {r.level} →</span>
                <span className="flex-1 truncate font-medium" style={{ color: r.role.color ? `#${r.role.color.toString(16).padStart(6, "0")}` : undefined }}>
                  {r.role.name}
                </span>
                <button onClick={() => removeReward.mutate(r.id)} className="text-signal-faint hover:text-dnd" title="Remove reward">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="mt-1.5 flex gap-2">
              <input
                type="number" min={1} max={500} value={rewardLevel}
                onChange={(e) => setRewardLevel(Number(e.target.value))}
                aria-label="Level"
                className="w-20 rounded bg-base-900 px-2 py-1.5 text-sm text-signal ring-1 ring-base-600"
              />
              <select
                value={rewardRole} onChange={(e) => setRewardRole(e.target.value)} aria-label="Role to grant"
                className="flex-1 rounded bg-base-900 px-2 py-1.5 text-sm text-signal ring-1 ring-base-600"
              >
                <option value="">Pick a role…</option>
                {assignableRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button
                onClick={() => rewardRole && addReward.mutate({ level: rewardLevel, roleId: rewardRole })}
                disabled={!rewardRole || addReward.isPending}
                className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
