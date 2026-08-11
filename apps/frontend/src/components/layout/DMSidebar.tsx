import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Plus, Settings, Mic, MicOff, Headphones, Users, X } from "lucide-react";
import { useDMs, useCreateDM } from "../../queries/dms";
import { useFriendRequests, useFriends } from "../../queries/friends";
import { useAuthStore } from "../../store/authStore";
import { useUIStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";
import { UserAvatar } from "../common/UserAvatar";
import { UserSearchInput, type LookupUser } from "../common/UserSearchInput";
import { usePresenceStore } from "../../store/presenceStore";
import { reportError } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/**
 * @param variant "sidebar" (default) — DMRoute usage: a secondary nav next to an open
 *   conversation's ChatPane, so on mobile it's gated behind the same left-nav drawer slot
 *   ChannelSidebar uses ("channels"), hidden until opened. "primary" — HomeRoute usage: there's
 *   no ChatPane there (just a placeholder), so it IS the main mobile content and stays visible
 *   full-width rather than behind a drawer.
 */
export function DMSidebar({ variant = "sidebar" }: { variant?: "sidebar" | "primary" }) {
  const { data: conversations } = useDMs();
  const { data: friendRequests } = useFriendRequests();
  const { conversationId: activeId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const presenceByUserId = usePresenceStore((s) => s.presenceByUserId);
  const inVoiceCall = useVoiceStore((s) => !!s.channelId);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const createDM = useCreateDM();
  const { data: friends } = useFriends();
  const [showNewDM, setShowNewDM] = useState(false);
  // Full user objects, not just ids: the chosen-people chips need avatar and name, and refetching
  // them after they were already returned by the search would be a pointless round trip.
  const [selectedUsers, setSelectedUsers] = useState<LookupUser[]>([]);
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  // Reuses the same drawer slot as ChannelSidebar's ("channels") — a user is only ever in one
  // context (server nav or DM nav) at a time, so one left-hand overlay slot covers both.
  const isMobileOpen = variant === "sidebar" && mobileDrawer === "channels";

  // Previously a raw "User ID" text box that only ever created a 1:1 — the backend
  // (POST /api/dm) always supported multiple participantIds/isGroup, nothing in the UI let you
  // reach it. Picking 2+ friends here creates a real group DM.
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
    <>
      {isMobileOpen && (
        <div className="mobile-drawer-backdrop fixed inset-0 z-30 md:hidden" onClick={closeMobileDrawer} />
      )}
      <div
        className={cn(
          "h-full w-60 shrink-0 flex-col bg-base-800 md:flex",
          variant === "primary"
            ? "flex w-full md:w-60"
            : isMobileOpen
              ? "fixed inset-y-0 left-[72px] z-40 flex shadow-2xl"
              : "hidden",
        )}
      >
      <div className="flex h-12 shrink-0 items-center border-b border-base-900/60 px-4 font-semibold text-signal shadow-sm">
        Direct Messages
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <button
          onClick={() => {
            navigate("/friends");
            closeMobileDrawer();
          }}
          className={cn(
            "mb-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-medium",
            location.pathname === "/friends" ? "bg-base-500 text-signal" : "text-signal-dim hover:bg-base-600 hover:text-signal",
          )}
        >
          <Users size={16} />
          Friends
          {friendRequests?.incoming.length ? (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-dnd px-1 font-mono text-[0.6rem] text-white">
              {friendRequests.incoming.length}
            </span>
          ) : null}
        </button>
        <button
          onClick={() => setShowNewDM((s) => !s)}
          className="mb-2 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm font-medium text-signal-dim hover:bg-base-600 hover:text-signal"
        >
          <Plus size={16} /> New DM
        </button>
        {showNewDM && (
          <div className="mb-3 flex flex-col gap-2 rounded bg-base-900 p-2">
            <span className="px-1 text-[10px] font-bold uppercase text-signal-faint">
              {selectedUsers.length > 1 ? "New group DM" : "New DM"}
            </span>

            {/* Search across everyone, not just existing friends. The old picker could only list
                friends, so starting a conversation with someone new was impossible from here even
                though the backend has always allowed it. */}
            <UserSearchInput
              placeholder="Search for people…"
              excludeIds={selectedUsers.map((u) => u.id)}
              keepQueryOnSelect
              limit={6}
              onSelect={(u) =>
                setSelectedUsers((prev) => (prev.some((p) => p.id === u.id) ? prev : [...prev, u]))
              }
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
              className="rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {selectedUsers.length > 1 ? `Start group with ${selectedUsers.length}` : "Start conversation"}
            </button>
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {conversations?.map((c) => {
            const other = c.participants.find((p) => p.id !== user?.id) ?? c.participants[0];
            const label = c.isGroup ? (c.name ?? c.participants.map((p) => p.displayName ?? p.username).join(", ")) : (other?.displayName ?? other?.username ?? "Unknown");
            return (
              <div
                key={c.id}
                className={cn(
                  "group flex items-center rounded",
                  c.id === activeId ? "bg-base-500 text-signal" : "text-signal-dim hover:bg-base-600 hover:text-signal",
                )}
              >
                <button
                  onClick={() => {
                    navigate(`/dm/${c.id}`);
                    closeMobileDrawer();
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                >
                  <UserAvatar
                    avatarUrl={other?.avatarUrl ?? null}
                    name={label}
                    size={32}
                    presence={other ? (presenceByUserId[other.id] ?? other.presence) : undefined}
                  />
                  <span className="truncate text-sm font-medium">{label}</span>
                </button>
                {c.isGroup && (
                  <button
                    onClick={() => openModalWith("groupDMSettings", { conversationId: c.id })}
                    title="Group settings"
                    className="mr-1.5 shrink-0 rounded p-1 opacity-0 hover:bg-base-500 hover:text-signal group-hover:opacity-100"
                  >
                    <Settings size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {user && (
        <div className="flex h-[52px] shrink-0 items-center gap-1.5 bg-base-900 px-2">
          <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={32} presence={user.presence} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-signal">{user.displayName ?? user.username}</div>
            <div className="truncate text-xs text-signal-dim">{user.statusText ?? `@${user.username}`}</div>
          </div>
          <button
            onClick={toggleMute}
            disabled={!inVoiceCall}
            className={cn("rounded p-1 hover:bg-base-600", voiceMuted ? "text-dnd" : "text-signal-dim hover:text-signal", !inVoiceCall && "opacity-40")}
            title={inVoiceCall ? (voiceMuted ? "Unmute" : "Mute") : "Join a voice channel to mute"}
          >
            {voiceMuted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            onClick={toggleDeafen}
            disabled={!inVoiceCall}
            className={cn("rounded p-1 hover:bg-base-600", voiceDeafened ? "text-dnd" : "text-signal-dim hover:text-signal", !inVoiceCall && "opacity-40")}
            title={inVoiceCall ? (voiceDeafened ? "Undeafen" : "Deafen") : "Join a voice channel to deafen"}
          >
            <Headphones size={16} />
          </button>
          <button
            onClick={() => openModalWith("userSettings")}
            className="rounded p-1 text-signal-dim hover:bg-base-600 hover:text-signal"
            title="User Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      )}
      </div>
    </>
  );
}
