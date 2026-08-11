import { APP_HOME } from "../../lib/platform";
import { useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, Hash, MessageCircle, Bell, CircleUserRound, Clapperboard } from "lucide-react";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { cn } from "../../lib/cn";

/** Bottom-anchored primary nav for <768px viewports (same bundle the Capacitor Android app
 * wraps at phone widths) — mirrors the approved design pitch's phone-bottom-nav concept:
 * navigation within thumb reach instead of stacked at the top of the screen. Servers/Channels
 * open the corresponding slide-out drawer (see ServerRail.tsx / ChannelSidebar.tsx /
 * DMSidebar.tsx, all driven by uiStore's `mobileDrawer`), DMs is a real route, Profile opens
 * the existing user settings modal, Activity opens the @mentions feed (see ActivityFeed.tsx). */
export function MobileBottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);
  const openMobileDrawer = useUIStore((s) => s.openMobileDrawer);
  const openModalWith = useUIStore((s) => s.openModalWith);

  const isDMs = mobileDrawer === null && (location.pathname === "/" || location.pathname.startsWith("/dm"));
  const isFeed = mobileDrawer === null && location.pathname.startsWith("/foryou");
  // Hidden unless the account is a confirmed adult — the feed routes refuse anyone else, and a tab
  // that always errors is worse than no tab.
  const canUseFeed = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);

  const items: Array<{ key: string; label: string; icon: typeof LayoutGrid; active: boolean; onClick: () => void }> = [
    {
      key: "servers",
      label: "Servers",
      icon: LayoutGrid,
      active: mobileDrawer === "servers",
      onClick: () => openMobileDrawer(mobileDrawer === "servers" ? null : "servers"),
    },
    {
      key: "channels",
      label: "Channels",
      icon: Hash,
      active: mobileDrawer === "channels",
      onClick: () => openMobileDrawer(mobileDrawer === "channels" ? null : "channels"),
    },
    {
      key: "dms",
      label: "DMs",
      icon: MessageCircle,
      active: isDMs,
      onClick: () => {
        openMobileDrawer(null);
        navigate(APP_HOME);
      },
    },
    ...(canUseFeed
      ? [
          {
            key: "feed",
            label: "Feed",
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
      onClick: () => openMobileDrawer(mobileDrawer === "activity" ? null : "activity"),
    },
    {
      key: "profile",
      label: "Profile",
      icon: CircleUserRound,
      active: false,
      onClick: () => openModalWith("userSettings"),
    },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-around border-t border-base-900/60 bg-base-900 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden"
      style={{ height: "calc(3.25rem + env(safe-area-inset-bottom))" }}
    >
      {items.map(({ key, label, icon: Icon, active, onClick }) => (
        <button
          key={key}
          onClick={onClick}
          title={label}
          className={cn("flex flex-col items-center gap-0.5 px-3 py-1 text-[0.6rem] font-medium", active ? "text-signal" : "text-signal-faint")}
        >
          <Icon size={20} className={active ? "text-accent" : undefined} />
          {label}
        </button>
      ))}
    </nav>
  );
}
