import { useNavigate } from "react-router-dom";
import { InboxPanel } from "../inbox/InboxPanel";
import { AtSign, Bell } from "lucide-react";
import { useMyMentions } from "../../queries/mentions";
import { useUIStore } from "../../store/uiStore";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

/** Mobile bottom nav's "Activity" tab (see AppShell.tsx / MobileBottomNav.tsx) — replaced the
 * old static "coming soon" placeholder once GET /api/users/me/mentions + the
 * NOTIFICATION_MENTION realtime event actually existed to back it (see
 * modules/messages/mentions.ts on the backend). */
export function ActivityFeed() {
  const { data: mentions, isLoading } = useMyMentions();
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const navigate = useNavigate();

  return (
    <>
      <div className="lx-scrim fixed inset-0 z-30 md:hidden" onClick={closeMobileDrawer} />
      {/* Anchored just above the tab bar rather than at a fixed `bottom-20`, which was a guess that
          drifted whenever the bar changed height (it is shorter in landscape) or the keyboard
          opened. */}
      <div className="lx-raised fixed inset-x-3 bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom)+var(--keyboard-inset)+0.5rem)] z-40 flex max-h-[calc(var(--app-height-safe)*0.60)] flex-col overflow-hidden md:hidden">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-4 py-3 text-sm font-semibold text-signal">
          <AtSign size={16} className="text-accent" /> Activity
        </div>
        <InboxPanel onNavigate={closeMobileDrawer} />
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <p className="px-2 py-4 text-center text-sm text-signal-faint">Loading…</p>
          ) : mentions && mentions.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {mentions.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    navigate(`/channels/${m.serverId}/${m.channelId}`);
                    closeMobileDrawer();
                  }}
                  className="lx-row lx-focus flex-col items-stretch gap-0.5 px-2.5 py-2"
                >
                  <div className="lx-eyebrow flex items-center gap-1.5">
                    <span className="text-signal-dim">{m.serverName}</span>
                    <span>{m.channelName}</span>
                    <span className="ml-auto shrink-0">{formatTime(m.createdAt)}</span>
                  </div>
                  <div className="truncate text-sm text-signal">
                    <span className="font-semibold">{m.message.author?.displayName ?? m.message.author?.username ?? "Unknown"}</span>{" "}
                    <span className="text-signal-dim">{m.message.content}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
              <Bell size={28} className="text-signal-faint" />
              <p className="text-sm font-semibold text-signal">No mentions yet</p>
              <p className="text-xs text-signal-dim">@mentions addressed to you will show up here.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
