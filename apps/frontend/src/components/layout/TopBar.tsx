import { Bell, Rocket, Hash, Users, Search, UserPlus, Rows3, AlignJustify, Sun, Moon, Menu, Pin } from "lucide-react";
import { InboxPanel } from "../inbox/InboxPanel";
import { useInboxUnread } from "../../queries/inbox";
import { useActivities } from "../../queries/game";
import { useActiveSelectionStore } from "../../store/activeSelectionStore";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { useUIStore } from "../../store/uiStore";
import { cn } from "../../lib/cn";

export function TopBar({
  title,
  topic,
  onSearch,
  serverId,
  pinnedCount,
  onTogglePins,
}: {
  title: string;
  topic?: string | null;
  onSearch?: (q: string) => void;
  serverId?: string;
  pinnedCount?: number;
  onTogglePins?: () => void;
}) {
  const toggleMemberList = useUIStore((s) => s.toggleMemberList);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const openMobileDrawer = useUIStore((s) => s.openMobileDrawer);
  const density = useUIStore((s) => s.density);
  const setDensity = useUIStore((s) => s.setDensity);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const [query, setQuery] = useState("");

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-base-900/60 px-4 shadow-sm">
      <button
        onClick={() => openMobileDrawer("channels")}
        className="-ml-1 shrink-0 text-signal-dim hover:text-signal md:hidden"
        title="Open channel list"
      >
        <Menu size={20} />
      </button>
      <Hash size={20} className="hidden shrink-0 font-mono text-signal-faint md:block" />
      <span className="truncate font-semibold text-signal">{title}</span>
      {topic ? (
        <>
          <div className="mx-1 h-5 w-px bg-base-500" />
          <span className="truncate text-sm text-signal-dim">{topic}</span>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        {onSearch ? (
          <div className="hidden items-center gap-1 rounded bg-base-900 px-2 py-1 md:flex">
            <input
              aria-label="Search Lumina"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                onSearch(e.target.value);
              }}
              placeholder="Search"
              className="w-36 bg-transparent text-sm text-signal outline-none placeholder:text-signal-faint"
            />
            <Search size={15} className="text-signal-faint" />
          </div>
        ) : null}

        <div className="hidden overflow-hidden rounded-lg border border-base-500 bg-base-900 sm:flex" title="Message density">
          <button
            onClick={() => setDensity("comfortable")}
            title="Comfortable"
            className={cn(
              "flex items-center gap-1 px-2 py-1 font-mono text-[0.7rem]",
              density === "comfortable" ? "bg-grad text-white" : "text-signal-dim hover:text-signal",
            )}
          >
            <AlignJustify size={13} />
          </button>
          <button
            onClick={() => setDensity("compact")}
            title="Compact"
            className={cn(
              "flex items-center gap-1 px-2 py-1 font-mono text-[0.7rem]",
              density === "compact" ? "bg-grad text-white" : "text-signal-dim hover:text-signal",
            )}
          >
            <Rows3 size={13} />
          </button>
        </div>

        <button
          onClick={toggleTheme}
          className="hidden text-signal-dim hover:text-signal sm:block"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <InboxBell />
        {serverId ? <ActivityLauncher /> : null}
        {onTogglePins ? (
          <button onClick={onTogglePins} className="relative text-signal-dim hover:text-signal" title="Pinned messages">
            <Pin size={18} />
            {pinnedCount ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 font-mono text-[0.55rem] text-white">
                {pinnedCount}
              </span>
            ) : null}
          </button>
        ) : null}

        {serverId ? (
          <button
            onClick={() => openModalWith("invite", { serverId })}
            className="hidden items-center gap-1.5 rounded bg-base-600 px-2.5 py-1 text-sm font-medium text-signal hover:bg-base-500 sm:flex"
            title="Invite People"
          >
            <UserPlus size={16} />
            <span className="hidden lg:inline">Invite People</span>
            <span className="sr-only lg:hidden">Invite People</span>
          </button>
        ) : null}
        <button onClick={toggleMemberList} className="hidden text-signal-dim hover:text-signal md:block" title="Toggle member list">
          <Users size={20} />
        </button>
      </div>
    </div>
  );
}


/** Rocket dropdown listing registered activities. Lives in the channel TopBar only — an activity
 * needs a room to be "in", and DMs don't take part in v1. */
function ActivityLauncher() {
  const [open, setOpen] = useState(false);
  const { data: activities } = useActivities(open);
  const setOpenActivity = useActiveSelectionStore((s) => s.setOpenActivity);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="text-signal-dim hover:text-signal" title="Activities">
          <Rocket size={18} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-72 rounded-lg border border-base-500 bg-base-700 p-1.5 shadow-xl">
          <p className="px-2 py-1 text-[11px] font-bold uppercase text-signal-dim">Activities</p>
          {(activities ?? []).length === 0 && (
            <p className="px-2 pb-2 text-xs text-signal-faint">
              None registered yet. Developers can add one in Settings → Developer Portal.
            </p>
          )}
          {(activities ?? []).map((a) => (
            <DropdownMenu.Item
              key={a.id}
              onSelect={() => setOpenActivity(a)}
              className="cursor-pointer rounded px-2 py-1.5 text-sm text-signal outline-none data-[highlighted]:bg-base-600"
            >
              <span className="block truncate font-medium">{a.name}</span>
              <span className="block truncate text-[11px] text-signal-faint">{a.appName ?? new URL(a.url).hostname}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}


/** The Activity bell — unread count from its own tiny endpoint, list on demand. */
function InboxBell() {
  const [open, setOpen] = useState(false);
  const { data: unread } = useInboxUnread();
  const count = unread?.count ?? 0;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="relative text-signal-dim hover:text-signal" title="Activity">
          <Bell size={18} />
          {count > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-dnd px-1 text-[10px] font-bold text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-96 max-w-[92vw] rounded-lg border border-base-500 bg-base-700 shadow-xl">
          <p className="border-b border-base-600 px-3 py-2 text-[11px] font-bold uppercase text-signal-dim">Activity</p>
          <InboxPanel onNavigate={() => setOpen(false)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
