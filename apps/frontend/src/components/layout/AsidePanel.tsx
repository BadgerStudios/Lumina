import { Pin, Users, X } from "lucide-react";
import { useUIStore, type AsideTab } from "../../store/uiStore";
import { useMembers } from "../../queries/members";
import { usePinnedMessages } from "../../queries/messages";
import { MemberRoster } from "./MemberRoster";
import { PinnedList } from "../chat/PinnedList";
import { cn } from "../../lib/cn";

/**
 * The contextual aside.
 *
 * The old right-hand column could only ever be the member list: it was always the same 240px of
 * names, it painted its own frame, and the only other room-scoped thing in the app (pins) had to
 * be a popover floating on top of the conversation instead. Both are now tabs of one panel, so the
 * space to the right of a room is worth what is actually useful there rather than being permanently
 * spent on one list.
 *
 * Above the layout breakpoint it is a column in the shell's flex row; below it, a right-hand sheet
 * over the content, since there is no room for a third column on a phone.
 */
export function AsidePanel({
  serverId,
  channelId,
  canManageMessages,
}: {
  serverId: string;
  channelId?: string;
  canManageMessages: boolean;
}) {
  const collapsed = useUIStore((s) => s.asideCollapsed);
  const tab = useUIStore((s) => s.asideTab);
  const setTab = useUIStore((s) => s.setAsideTab);
  const toggleAside = useUIStore((s) => s.toggleAside);
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const { data: members } = useMembers(serverId);
  // Shares the query key PinnedList uses, so the count in the tab costs no extra request and is
  // right before the tab has ever been opened.
  const { data: pins } = usePinnedMessages(channelId, !!channelId);

  const isSheetOpen = mobileDrawer === "aside";
  // Two independent switches on purpose: the desktop column is a persistent preference, the phone
  // sheet is a momentary one. Sharing a single boolean meant opening it on a phone left it open on
  // the desktop and vice versa.
  if (collapsed && !isSheetOpen) return null;

  const tabs: Array<{ key: AsideTab; label: string; icon: typeof Users; count?: number }> = [
    { key: "people", label: "People", icon: Users, count: members?.length },
    ...(channelId ? [{ key: "pins" as const, label: "Pinned", icon: Pin, count: pins?.length }] : []),
  ];

  return (
    <>
      {isSheetOpen && <div className="lx-scrim fixed inset-0 z-30 lg:hidden" onClick={closeMobileDrawer} />}
      <aside
        aria-label="Room details"
        className={cn(
          "lx-pane z-40 flex shrink-0 flex-col",
          // Below 1024px this is an overlay sheet, not a column — three columns need the width, and
          // squeezing a third one in at tablet-portrait left the conversation unusably narrow.
          "lx-sheet--aside max-lg:fixed max-lg:right-0 max-lg:w-[19rem] max-lg:max-w-[86vw] max-lg:rounded-none max-lg:border-r-0",
          isSheetOpen ? "max-lg:flex" : "max-lg:hidden",
          "lg:w-[16.5rem]",
        )}
      >
        <div className="flex shrink-0 items-center gap-0.5 border-b border-hairline p-1.5">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                data-active={tab === t.key}
                className="lx-row lx-focus w-auto flex-1 justify-center py-1.5 text-xs"
                aria-pressed={tab === t.key}
              >
                <Icon size={13} className="shrink-0" />
                <span className="truncate">{t.label}</span>
                {typeof t.count === "number" && (
                  <span className="shrink-0 font-mono text-[10px] opacity-60">{t.count}</span>
                )}
              </button>
            );
          })}
          <button
            onClick={() => (isSheetOpen ? closeMobileDrawer() : toggleAside())}
            className="lx-focus shrink-0 rounded-lg p-1.5 text-signal-faint hover:text-signal"
            title="Close panel"
            aria-label="Close panel"
          >
            <X size={14} />
          </button>
        </div>

        {tab === "pins" && channelId ? (
          <PinnedList channelId={channelId} canManage={canManageMessages} />
        ) : (
          <MemberRoster serverId={serverId} />
        )}
      </aside>
    </>
  );
}
