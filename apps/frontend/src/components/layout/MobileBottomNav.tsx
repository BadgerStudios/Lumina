import { useLocation, useNavigate } from "react-router-dom";
import { Bell, Clapperboard, CircleUserRound, MessageSquare, PanelLeft } from "lucide-react";
import { APP_HOME } from "../../lib/platform";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useInboxUnread } from "../../queries/inbox";
import { cn } from "../../lib/cn";

/**
 * Bottom-anchored primary nav for <768px viewports (the same bundle the Capacitor Android app
 * wraps at phone widths) — navigation within thumb reach rather than stacked at the top.
 *
 * It used to carry six or seven tabs, two of which ("Servers" and "Channels") existed only to open
 * the two halves of the old left-hand navigation. The deck merged those into one column, so those
 * two tabs collapse into a single Menu, and what is left is four destinations that are actually
 * different places rather than two doors into the same one.
 *
 * Staff and Owner used to have their own tabs here. They are one tap away at the top of the deck
 * now, and a six-tab bar on a 360px screen gives every tab less than a thumb's width.
 */
export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const openMobileDrawer = useUIStore((s) => s.openMobileDrawer);
  const openModalWith = useUIStore((s) => s.openModalWith);
  const { data: unread } = useInboxUnread();
  const unreadCount = unread?.count ?? 0;

  const atRest = mobileDrawer === null;
  const isMessages = atRest && (location.pathname === "/" || location.pathname === "/app" || location.pathname.startsWith("/dm") || location.pathname === "/friends");
  const isFeed = atRest && location.pathname.startsWith("/foryou");
  // Hidden unless the account is a confirmed adult — the feed routes refuse anyone else, and a tab
  // that always errors is worse than no tab.
  const canUseFeed = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);

  const items: Array<{
    key: string;
    label: string;
    icon: typeof PanelLeft;
    active: boolean;
    badge?: number;
    onClick: () => void;
  }> = [
    {
      key: "menu",
      label: "Menu",
      icon: PanelLeft,
      active: mobileDrawer === "deck",
      onClick: () => openMobileDrawer(mobileDrawer === "deck" ? null : "deck"),
    },
    {
      key: "messages",
      label: "Messages",
      icon: MessageSquare,
      active: isMessages,
      onClick: () => {
        openMobileDrawer(null);
        navigate(APP_HOME);
      },
    },
    ...(canUseFeed
      ? [
          {
            key: "feed",
            label: "For You",
            icon: Clapperboard,
            active: isFeed,
            onClick: () => {
              openMobileDrawer(null);
              navigate("/foryou");
            },
          },
        ]
      : []),
    {
      key: "activity",
      label: "Activity",
      icon: Bell,
      active: mobileDrawer === "activity",
      badge: unreadCount,
      onClick: () => openMobileDrawer(mobileDrawer === "activity" ? null : "activity"),
    },
    {
      key: "you",
      label: "You",
      icon: CircleUserRound,
      active: false,
      onClick: () => openModalWith("userSettings"),
    },
  ];

  return (
    // `bottom-keyboard` rather than `bottom-0`: on iOS the layout viewport does not shrink when the
    // keyboard opens, so a bar pinned to bottom:0 ends up behind it. The inset is 0 otherwise.
    //
    // In landscape the caption under each icon is dropped and the bar loses ~14px of height. On a
    // 390px-tall viewport that row of captions is a real fraction of the screen, and the icons
    // carry the same meaning on their own — aria-label keeps them reachable for a screen reader.
    <nav
      className="fixed inset-x-0 bottom-keyboard z-50 flex items-center justify-around gap-0.5 overflow-hidden border-t border-hairline bg-base-900/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1.5 backdrop-blur-xl md:hidden"
      style={{ height: "calc(var(--bottom-nav-h) + env(safe-area-inset-bottom))" }}
      // Not "Primary": the deck already claims that landmark name, and both are in the DOM at
      // once (each hidden by a media query, which assistive tech does not treat as absent). Two
      // navigation landmarks with the same accessible name are indistinguishable in a landmark
      // list.
      aria-label="Quick navigation"
    >
      {items.map(({ key, label, icon: Icon, active, badge, onClick }) => (
        <button
          key={key}
          onClick={onClick}
          title={label}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          // min-w-0 + flex-1 + truncate, and NOT a fixed horizontal padding: the tabs have to be
          // able to give way. Android's Display-size and Font-size settings shrink the CSS viewport
          // the WebView reports — a 360dp phone can report ~300dp at the largest display size — and
          // the previous bar's fixed `px-3` on seven tabs simply ran the last one off the right edge
          // of the screen. That is a setting a lot of people turn on, and the tab it hid was the
          // profile.
          className={cn(
            "lx-focus relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1 text-[0.6rem] font-medium transition-colors",
            active ? "text-signal" : "text-signal-faint",
          )}
        >
          <span className="relative">
            <Icon size={19} className={active ? "text-accent" : undefined} />
            {badge ? (
              <span className="absolute -right-1.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-flare px-0.5 font-mono text-[8px] font-bold text-white">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </span>
          <span className="short:hidden w-full truncate text-center">{label}</span>
          {/* A short accent underline instead of a filled pill — the same "active" language the
              deck's rows use, so the two navigations read as one system. */}
          <span
            className={cn(
              "absolute -top-1.5 h-0.5 w-5 rounded-full transition-opacity",
              active ? "bg-accent opacity-100" : "opacity-0",
            )}
          />
        </button>
      ))}
    </nav>
  );
}
