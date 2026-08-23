import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bell,
  ChevronRight,
  Compass,
  Crown,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Clapperboard,
  Sparkles,
  Store,
  X,
} from "lucide-react";
import { APP_HOME } from "../../lib/platform";
import { useAuthStore } from "../../store/authStore";
import { isStaff as checkStaff, isOwner as checkOwner } from "../../lib/platformRole";
import { useServers } from "../../queries/servers";
import { useInboxUnread } from "../../queries/inbox";
import { useUIStore } from "../../store/uiStore";
import { resolveAssetUrl } from "../../lib/apiClient";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../common/UserAvatar";
import { InboxPanel } from "../inbox/InboxPanel";
import { MessagesBranch } from "./deck/MessagesBranch";
import { SpaceBranch, SpaceMenu } from "./deck/SpaceBranch";

/**
 * The nav deck — one column for everywhere you can go.
 *
 * It replaces the pair of nested left rails the app used to have: a 72px column of unlabelled
 * community icons, and beside it a 240px column whose entire contents swapped out when you clicked
 * one. That arrangement made every navigation a two-step act and gave a community's rooms no
 * visible relationship to the community itself.
 *
 * Here, everything is one outline. Destinations (Messages, For You, Discover, Studio, Store) and
 * spaces are rows in the same list; the ones that contain things expand in place to show them,
 * hanging off a branch line so the nesting is visible without indenting rows off the edge. Exactly
 * one space is expanded at a time — the deck is a single scrolling column, and every space open at
 * once is the wall of names the two-rail design was trying to avoid.
 *
 * Mounted once by AppShell rather than per route, which is why ChannelRoute / DMRoute /
 * FriendsRoute / HomeRoute no longer each render their own sidebar.
 *
 * Collapsed mode narrows to avatars and icons for people who want the width back; the state is
 * persisted (see uiStore). Below the layout breakpoint the whole thing becomes a left sheet driven
 * by the single "deck" drawer slot.
 */

function DeckSectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="lx-eyebrow px-2 pb-1 pt-3">{children}</div>;
}

/** The activity bell — unread count from its own tiny endpoint, list on demand. */
function DeckInbox({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: unread } = useInboxUnread();
  const count = unread?.count ?? 0;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="lx-focus relative rounded-lg p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal"
          title="Activity"
          aria-label="Activity"
        >
          <Bell size={16} />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-flare px-0.5 font-mono text-[9px] font-bold text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={collapsed ? "center" : "start"}
          side="right"
          sideOffset={8}
          className="lx-raised z-50 w-96 max-w-[92vw] overflow-hidden"
        >
          <p className="lx-eyebrow border-b border-hairline px-3 py-2">Activity</p>
          <InboxPanel onNavigate={() => setOpen(false)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One space's mark, and the single definition of what a space with no icon looks like — the deck
 * and Home disagreed about this ("AC" vs "AU" for the same space) until they shared it. */
export function spaceInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function SpaceAvatar({ name, iconUrl, size = 22 }: { name: string; iconUrl: string | null; size?: number }) {
  const initials = spaceInitials(name);
  return iconUrl ? (
    <img
      src={resolveAssetUrl(iconUrl)}
      alt=""
      aria-hidden="true"
      className="shrink-0 rounded-lg object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      // A neutral raised chip, not the accent gradient. White initials on the gradient measured
      // 2.17:1 against the solar accent and 2.52:1 against forest — the brand colours are bright,
      // and the fallback avatar has to stay readable under all five of them.
      className="flex shrink-0 items-center justify-center rounded-lg bg-base-600 font-display font-bold text-signal ring-1 ring-inset ring-hairline"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function NavDeck() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { serverId } = useParams<{ serverId?: string }>();
  const { data: servers } = useServers();
  const user = useAuthStore((s) => s.user);
  const platformRole = useAuthStore((s) => s.user?.platformRole);
  // Rank comparison, never equality — MASTER is above OWNER and would fail an === check, hiding
  // both entries from the one account that should always see them. The role only decides whether
  // the entry renders; the API enforces the real check.
  const isStaff = checkStaff(platformRole);
  const isOwner = checkOwner(platformRole);
  // "Confirmed adult", not "can use the feed": the same predicate gates the feed, Discover, Studio
  // AND the store, every one of whose endpoints sits behind requireAdult on the backend. A row that
  // can only ever produce an error page is worse than no row.
  const isConfirmedAdult = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);

  const collapsed = useUIStore((s) => s.deckCollapsed);
  const toggleDeck = useUIStore((s) => s.toggleDeck);
  const expandedSpaceId = useUIStore((s) => s.expandedSpaceId);
  const setExpandedSpace = useUIStore((s) => s.setExpandedSpace);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const setCommandOpen = useUIStore((s) => s.setCommandOpen);
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const isSheetOpen = mobileDrawer === "deck";

  const inMessages = pathname === "/" || pathname === "/app" || pathname.startsWith("/dm") || pathname === "/friends";
  const [messagesOpen, setMessagesOpen] = useState(inMessages);

  // Walking into a space opens it, and walking into Messages opens that. Without this, arriving
  // somewhere by any route other than clicking its own deck row (an invite link, a notification, a
  // mention jump, the back button) would leave the deck showing a different place than the one on
  // screen.
  useEffect(() => {
    if (serverId) setExpandedSpace(serverId);
  }, [serverId, setExpandedSpace]);
  useEffect(() => {
    if (inMessages) setMessagesOpen(true);
  }, [inMessages]);

  const destinations = [
    ...(isConfirmedAdult
      ? [
          { key: "foryou", to: "/foryou", label: "For You", icon: Clapperboard },
          { key: "discover", to: "/discover", label: "Discover", icon: Compass },
          { key: "studio", to: "/studio", label: "Studio", icon: Sparkles },
          { key: "store", to: "/store", label: "Store", icon: Store },
        ]
      : []),
    ...(isStaff ? [{ key: "staff", to: "/staff", label: "Staff", icon: ShieldCheck }] : []),
    ...(isOwner ? [{ key: "owner", to: "/owner", label: "Owner", icon: Crown }] : []),
  ];

  function go(to: string) {
    navigate(to);
    closeMobileDrawer();
  }

  return (
    <>
      {isSheetOpen && <div className="lx-scrim fixed inset-0 z-30 md:hidden" onClick={closeMobileDrawer} />}
      <nav
        aria-label="Primary"
        data-collapsed={collapsed}
        className={cn(
          "lx-deck lx-pane relative z-40 flex shrink-0 flex-col",
          // Below the layout breakpoint the deck is a sheet, not a column: full height, over the
          // content, dismissed by the scrim. Above it, a static column in the shell's flex row.
          "lx-sheet max-md:fixed max-md:left-0 max-md:w-[19rem] max-md:max-w-[86vw] max-md:rounded-none max-md:border-l-0",
          isSheetOpen ? "max-md:flex" : "max-md:hidden",
        )}
      >
        {/* ---- header ---- */}
        <div className={cn("flex shrink-0 items-center gap-1.5 px-2.5 pb-1 pt-2.5", collapsed && "flex-col")}>
          <Link
            to={APP_HOME}
            onClick={closeMobileDrawer}
            className="lx-focus flex min-w-0 items-center gap-2 rounded-lg"
            title="Lumina"
          >
            <img src="/icons/logo-128.png" alt="" aria-hidden="true" className="h-7 w-7 shrink-0 rounded-lg" />
            {!collapsed && <span className="truncate font-display text-sm font-bold tracking-tight text-signal">Lumina</span>}
          </Link>
          <div className={cn("flex items-center gap-0.5", !collapsed && "ml-auto")}>
            <DeckInbox collapsed={collapsed} />
            <button
              onClick={toggleDeck}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              className="lx-focus hidden rounded-lg p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal md:block"
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <button
              onClick={closeMobileDrawer}
              title="Close navigation"
              aria-label="Close navigation"
              className="lx-focus rounded-lg p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal md:hidden"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ---- jump ---- */}
        <div className="shrink-0 px-2 pb-1 pt-0.5">
          <button
            onClick={() => setCommandOpen(true)}
            className={cn(
              "lx-focus flex w-full items-center gap-2 rounded-lg border border-hairline bg-base-900/50 px-2 py-1.5 text-left text-xs text-signal-faint transition hover:border-accent hover:text-signal-dim",
              collapsed && "justify-center px-0",
            )}
            title="Jump to anything"
            aria-label="Jump to anything"
          >
            <Search size={14} className="shrink-0" />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 truncate">Jump to…</span>
                <kbd className="shrink-0 rounded border border-hairline px-1 font-mono text-[9px]">⌘K</kbd>
              </>
            )}
          </button>
        </div>

        {/* ---- outline ---- */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {/* Messages */}
          {collapsed ? (
            <button
              onClick={() => go(APP_HOME)}
              data-active={inMessages}
              className="lx-row lx-focus justify-center"
              title="Messages"
              aria-label="Messages"
            >
              <MessageSquare size={17} className="shrink-0" />
            </button>
          ) : (
            <>
              <div className="group relative flex items-center">
                <button
                  onClick={() => {
                    // Same rule as a space: in the sheet this row only opens the branch, because
                    // navigating would close the sheet over the list it just revealed.
                    if (isSheetOpen) {
                      setMessagesOpen((v) => !v);
                      return;
                    }
                    if (!inMessages) go(APP_HOME);
                    setMessagesOpen((v) => (inMessages ? !v : true));
                  }}
                  data-active={inMessages}
                  aria-expanded={messagesOpen}
                  className="lx-row lx-focus text-sm"
                >
                  <ChevronRight
                    size={13}
                    className={cn("shrink-0 text-signal-faint transition-transform", messagesOpen && "rotate-90")}
                  />
                  <MessageSquare size={15} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Messages</span>
                </button>
              </div>
              {messagesOpen && <MessagesBranch />}
            </>
          )}

          {/* Destinations */}
          {destinations.length > 0 && !collapsed && <DeckSectionLabel>Explore</DeckSectionLabel>}
          {collapsed && destinations.length > 0 && <div className="my-1.5 h-px bg-hairline" />}
          <div className="flex flex-col gap-px">
            {destinations.map((d) => {
              const active = pathname.startsWith(d.to);
              const Icon = d.icon;
              return (
                <button
                  key={d.key}
                  onClick={() => go(d.to)}
                  data-active={active}
                  title={d.label}
                  aria-label={d.label}
                  className={cn("lx-row lx-focus text-sm", collapsed && "justify-center")}
                >
                  <Icon size={collapsed ? 17 : 15} className="shrink-0" />
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{d.label}</span>}
                </button>
              );
            })}
          </div>

          {/* Spaces */}
          {!collapsed && <DeckSectionLabel>Spaces</DeckSectionLabel>}
          {collapsed && <div className="my-1.5 h-px bg-hairline" />}
          <div className="flex flex-col gap-px">
            {servers?.map((s) => {
              const isCurrent = s.id === serverId;
              const isExpanded = !collapsed && expandedSpaceId === s.id;
              return (
                <div key={s.id}>
                  <div className="group relative flex items-center">
                    <button
                      onClick={() => {
                        if (collapsed) {
                          // No room to expand anything — go straight in. ChannelRoute resolves the
                          // `_` placeholder to the space's first text room once its list loads.
                          go(`/channels/${s.id}/_`);
                          return;
                        }
                        if (isSheetOpen) {
                          // In the phone sheet, tapping a space ONLY expands it. Navigating here
                          // as well would dismiss the sheet in the same gesture (see `go`), so the
                          // rooms you just asked to see would be gone before you saw them — you
                          // would land in whichever room happened to be first, every time.
                          setExpandedSpace(isExpanded ? null : s.id);
                          return;
                        }
                        if (isExpanded) {
                          setExpandedSpace(null);
                        } else {
                          setExpandedSpace(s.id);
                          if (!isCurrent) go(`/channels/${s.id}/_`);
                        }
                      }}
                      data-active={isCurrent}
                      aria-expanded={collapsed ? undefined : isExpanded}
                      title={s.name}
                      className={cn("lx-row lx-focus text-sm", collapsed && "justify-center")}
                    >
                      {!collapsed && (
                        <ChevronRight
                          size={13}
                          className={cn("shrink-0 text-signal-faint transition-transform", isExpanded && "rotate-90")}
                        />
                      )}
                      <SpaceAvatar name={s.name} iconUrl={s.iconUrl} size={collapsed ? 28 : 22} />
                      {!collapsed && <span className="min-w-0 flex-1 truncate">{s.name}</span>}
                    </button>
                    {!collapsed && (
                      // Opacity, never `display`, for anything a popover anchors to: see SpaceMenu.
                      <span className="absolute right-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
                        <SpaceMenu serverId={s.id} />
                      </span>
                    )}
                  </div>
                  {isExpanded && <SpaceBranch serverId={s.id} />}
                </div>
              );
            })}

            <button
              onClick={() => openModalWith("createServer")}
              title="Create or join a space"
              aria-label="Create or join a space"
              className={cn("lx-row lx-focus text-sm text-signal-faint", collapsed && "justify-center")}
            >
              <Plus size={collapsed ? 17 : 15} className="shrink-0" />
              {!collapsed && <span className="min-w-0 flex-1 truncate">Add a space</span>}
            </button>
          </div>
        </div>

        {/* ---- you ---- */}
        {user && (
          <div className="shrink-0 border-t border-hairline p-1.5">
            <button
              onClick={() => openModalWith("userSettings")}
              title="Your profile and settings"
              className={cn("lx-row lx-focus", collapsed && "justify-center")}
            >
              <UserAvatar
                avatarUrl={user.avatarUrl}
                name={user.displayName ?? user.username}
                size={collapsed ? 28 : 26}
                presence={user.presence}
              />
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-signal">
                      {user.displayName ?? user.username}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-signal-faint">
                      {user.statusText ?? `@${user.username}`}
                    </span>
                  </span>
                  <Settings size={14} className="shrink-0 text-signal-faint" />
                </>
              )}
            </button>
          </div>
        )}
      </nav>
    </>
  );
}
