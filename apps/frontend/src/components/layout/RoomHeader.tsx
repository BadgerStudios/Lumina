import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu, Pin, Rocket, Search, UserPlus, Users, X } from "lucide-react";
import { useActivities } from "../../queries/game";
import { useServer } from "../../queries/servers";
import { useActiveSelectionStore } from "../../store/activeSelectionStore";
import { useUIStore, selectAsideOpen } from "../../store/uiStore";
import { cn } from "../../lib/cn";
import { OfficialServerBadge } from "../common/OfficialBadge";

/**
 * The room's context bar.
 *
 * The old header was a solid, full-bleed 48px band welded to the top of the message column, and it
 * had become the app's junk drawer — density toggle, theme toggle, search, activities, pins,
 * invite, member toggle, all competing at the same weight. Two of those (density, theme) are
 * preferences that belong in settings, where they already are, so they are gone from here.
 *
 * What is left reads as a capsule floating over the conversation rather than a chrome bar bolted
 * onto it: rounded, translucent, inset from the pane's edges. It stays in normal flow rather than
 * being absolutely positioned — it *looks* detached but cannot overlap the first message, which an
 * overlay does at some zoom levels and font sizes.
 */
export function RoomHeader({
  title,
  topic,
  serverId,
  onSearch,
  pinnedCount,
  onTogglePins,
  pinsOpen,
}: {
  title: string;
  topic?: string | null;
  onSearch?: (q: string) => void;
  serverId?: string;
  pinnedCount?: number;
  onTogglePins?: () => void;
  pinsOpen?: boolean;
}) {
  const toggleAside = useUIStore((s) => s.toggleAside);
  const asideOpen = useUIStore(selectAsideOpen);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const openMobileDrawer = useUIStore((s) => s.openMobileDrawer);
  const { data: server } = useServer(serverId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const btn =
    "lx-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-signal-dim transition hover:bg-base-600 hover:text-signal";

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
    onSearch?.("");
  }

  return (
    <div className="lx-capsule mx-2 mt-2 flex h-11 shrink-0 items-center gap-2 px-2">
      <button
        onClick={() => openMobileDrawer("deck")}
        className="lx-focus -ml-0.5 shrink-0 rounded-lg p-1 text-signal-dim hover:text-signal md:hidden"
        title="Open navigation"
        aria-label="Open navigation"
      >
        <Menu size={18} />
      </button>

      {/* Breadcrumb rather than a bare name: which space a room belongs to used to be knowable
          only from whichever icon happened to be lit in the rail. */}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        {server?.name ? (
          <>
            {/* min-w-0 and no shrink-0: this is the first thing that should give way. It used to be
                a fixed 9rem that refused to shrink, so on a narrow pane it drove straight through
                the room name and the action icons instead of truncating. Also raised from `sm` to
                `lg` — below that the pane has better uses for the width. */}
            <span className="hidden min-w-0 max-w-[9rem] truncate font-mono text-[0.62rem] uppercase tracking-widest text-signal-dim lg:block">
              {server.name}
            </span>
            {server.isOfficial ? <OfficialServerBadge compact /> : null}
            <span className="hidden shrink-0 text-signal-faint lg:block">/</span>
          </>
        ) : null}
        <span className="truncate text-sm font-semibold text-signal">{title}</span>
        {topic ? (
          <>
            <span className="hidden shrink-0 text-signal-faint lg:block">·</span>
            <span className="hidden min-w-0 truncate text-xs text-signal-dim lg:block">{topic}</span>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {onSearch ? (
          searchOpen ? (
            <div className="flex items-center gap-1 rounded-lg border border-hairline bg-base-900/60 px-2 py-1">
              <Search size={13} className="shrink-0 text-signal-faint" />
              <input
                aria-label="Search messages"
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  onSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
                placeholder="Search…"
                className="w-28 bg-transparent text-xs text-signal outline-none placeholder:text-signal-faint sm:w-40"
              />
              <button onClick={closeSearch} className="shrink-0 text-signal-faint hover:text-signal" aria-label="Close search">
                <X size={13} />
              </button>
            </div>
          ) : (
            <button onClick={() => setSearchOpen(true)} className={btn} title="Search messages" aria-label="Search messages">
              <Search size={16} />
            </button>
          )
        ) : null}

        {serverId ? <ActivityLauncher /> : null}

        {onTogglePins ? (
          <button
            onClick={onTogglePins}
            className={cn(btn, "relative", pinsOpen && "bg-base-600 text-signal")}
            title="Pinned messages"
            aria-label="Pinned messages"
            aria-pressed={pinsOpen}
          >
            <Pin size={16} />
            {pinnedCount ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-accent px-0.5 font-mono text-[8px] font-bold text-white">
                {pinnedCount}
              </span>
            ) : null}
          </button>
        ) : null}

        {serverId ? (
          <button
            onClick={() => openModalWith("invite", { serverId })}
            className={btn}
            title="Invite people"
            aria-label="Invite people"
          >
            <UserPlus size={16} />
          </button>
        ) : null}

        {serverId ? (
          <button
            onClick={toggleAside}
            className={cn(btn, asideOpen && "bg-base-600 text-signal")}
            title={asideOpen ? "Hide people" : "Show people"}
            aria-label={asideOpen ? "Hide people" : "Show people"}
            aria-pressed={asideOpen}
          >
            <Users size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Registered embeddable activities. Server rooms only — an activity needs a room to be "in", and
 * DMs don't take part. */
function ActivityLauncher() {
  const [open, setOpen] = useState(false);
  const { data: activities } = useActivities(open);
  const setOpenActivity = useActiveSelectionStore((s) => s.setOpenActivity);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="lx-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-signal-dim transition hover:bg-base-600 hover:text-signal"
          title="Activities"
          aria-label="Activities"
        >
          <Rocket size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="lx-raised z-50 w-72 p-1.5">
          <p className="lx-eyebrow px-2 py-1">Activities</p>
          {(activities ?? []).length === 0 && (
            <p className="px-2 pb-2 text-xs text-signal-faint">
              None registered yet. Developers can add one in Settings → Developer Portal.
            </p>
          )}
          {(activities ?? []).map((a) => (
            <DropdownMenu.Item
              key={a.id}
              onSelect={() => setOpenActivity(a)}
              className="cursor-pointer rounded-lg px-2 py-1.5 text-sm text-signal outline-none data-[highlighted]:bg-base-600"
            >
              <span className="block truncate font-medium">{a.name}</span>
              <span className="block truncate font-mono text-[10px] text-signal-faint">
                {a.appName ?? new URL(a.url).hostname}
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
