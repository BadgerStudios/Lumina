import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus, Settings, Users, X } from "lucide-react";
import { useDMs, useCreateDM } from "../../../queries/dms";
import { useFriendRequests } from "../../../queries/friends";
import { useAuthStore } from "../../../store/authStore";
import { useUIStore } from "../../../store/uiStore";
import { UserAvatar } from "../../common/UserAvatar";
import { UserSearchInput, type LookupUser } from "../../common/UserSearchInput";
import { usePresenceStore } from "../../../store/presenceStore";
import { reportError } from "../../../store/toastStore";
import { cn } from "../../../lib/cn";

/**
 * The "Messages" section of the nav deck, expanded.
 *
 * This is the conversation list that used to be its own 240px column (DMSidebar) sitting beside
 * the server rail. It is a branch of the deck now for the same reason spaces are: a person is
 * navigating one list of places, and which *kind* of place it is shouldn't decide whether it gets
 * its own column. The composer, the friends entry and the group-settings affordance all came
 * across unchanged — only the frame around them is different.
 */
export function MessagesBranch() {
  const { data: conversations } = useDMs();
  const { data: friendRequests } = useFriendRequests();
  const { conversationId: activeId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const presenceByUserId = usePresenceStore((s) => s.presenceByUserId);
  const createDM = useCreateDM();
  const [showNewDM, setShowNewDM] = useState(false);
  // Full user objects, not just ids: the chosen-people chips need avatar and name, and refetching
  // them after they were already returned by the search would be a pointless round trip.
  const [selectedUsers, setSelectedUsers] = useState<LookupUser[]>([]);

  async function handleCreateDM() {
    if (selectedUsers.length === 0) return;
    const ids = selectedUsers.map((u) => u.id);
    try {
      const convo = await createDM.mutateAsync({ participantIds: ids, isGroup: ids.length > 1 });
      setShowNewDM(false);
      setSelectedUsers([]);
      navigate(`/dm/${convo.id}`);
      closeMobileDrawer();
    } catch (e) {
      // The picker is deliberately left open and populated on failure — the refusal is often about
      // one specific person in the selection, and clearing it would make the user rebuild the
      // whole group to find out which.
      reportError(e, "Couldn't start that conversation.");
    }
  }

  return (
    <div className="lx-branch mt-0.5 flex flex-col gap-px pb-1">
      <button
        onClick={() => {
          navigate("/friends");
          closeMobileDrawer();
        }}
        data-active={location.pathname === "/friends"}
        className="lx-row lx-focus text-sm"
      >
        <Users size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">Friends</span>
        {friendRequests?.incoming.length ? (
          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-flare px-1 font-mono text-[0.6rem] text-white">
            {friendRequests.incoming.length}
          </span>
        ) : null}
      </button>

      <button onClick={() => setShowNewDM((s) => !s)} className="lx-row lx-focus text-sm">
        <Plus size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">New conversation</span>
      </button>

      {showNewDM && (
        <div className="my-1 flex flex-col gap-2 rounded-xl border border-hairline bg-base-900/60 p-2">
          <span className="lx-eyebrow px-0.5">{selectedUsers.length > 1 ? "New group" : "New message"}</span>

          {/* Search across everyone, not just existing friends — the backend has always allowed
              starting a conversation with a stranger. */}
          <UserSearchInput
            placeholder="Search for people…"
            excludeIds={selectedUsers.map((u) => u.id)}
            keepQueryOnSelect
            limit={6}
            onSelect={(u) => setSelectedUsers((prev) => (prev.some((p) => p.id === u.id) ? prev : [...prev, u]))}
          />

          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedUsers.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setSelectedUsers((prev) => prev.filter((p) => p.id !== u.id))}
                  className="flex items-center gap-1 rounded-full bg-base-600 py-0.5 pl-0.5 pr-2 text-xs text-signal"
                  title="Remove"
                >
                  <UserAvatar avatarUrl={u.avatarUrl} name={u.displayName ?? u.username} size={18} />
                  <span className="max-w-24 truncate">{u.displayName ?? u.username}</span>
                  <X size={11} className="shrink-0 text-signal-faint" />
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => void handleCreateDM()}
            disabled={createDM.isPending || selectedUsers.length === 0}
            className="rounded-lg bg-accent px-2 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {selectedUsers.length > 1 ? `Start group with ${selectedUsers.length}` : "Start conversation"}
          </button>
        </div>
      )}

      {conversations?.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-signal-faint">No conversations yet.</p>
      )}

      {conversations?.map((c) => {
        const other = c.participants.find((p) => p.id !== user?.id) ?? c.participants[0];
        const label = c.isGroup
          ? (c.name ?? c.participants.map((p) => p.displayName ?? p.username).join(", "))
          : (other?.displayName ?? other?.username ?? "Unknown");
        return (
          <div key={c.id} className="group relative">
            <button
              onClick={() => {
                navigate(`/dm/${c.id}`);
                closeMobileDrawer();
              }}
              data-active={c.id === activeId}
              className="lx-row lx-focus text-sm"
            >
              <UserAvatar
                avatarUrl={other?.avatarUrl ?? null}
                name={label}
                size={22}
                presence={other ? (presenceByUserId[other.id] ?? other.presence) : undefined}
              />
              <span className={cn("min-w-0 flex-1 truncate", c.isGroup && "italic")}>{label}</span>
            </button>
            {c.isGroup && (
              <button
                onClick={() => openModalWith("groupDMSettings", { conversationId: c.id })}
                title="Group settings"
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-signal-faint hover:text-signal group-hover:block max-md:block"
              >
                <Settings size={13} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
