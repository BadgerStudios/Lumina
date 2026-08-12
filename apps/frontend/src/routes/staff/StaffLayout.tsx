import { NavLink, Navigate, Outlet } from "react-router-dom";
import { ShieldCheck, Clapperboard, Flag, Megaphone, ScrollText } from "lucide-react";
import { APP_HOME } from "../../lib/platform";
import { useAuthStore } from "../../store/authStore";
import { isStaff } from "../../lib/platformRole";
import { useStaffVideoCounts } from "../../queries/staff";
import { useTickets } from "../../queries/reports";
import { useAdReviewQueue } from "../../queries/ads";
import { cn } from "../../lib/cn";

/**
 * The staff suite.
 *
 * ## Why this exists as a shell rather than more top-level routes
 *
 * Moderation was three surfaces that did not know about each other. `/staff/videos` was reachable
 * from one rail icon; `/staff/reports` existed and was linked from **nowhere at all**, so the whole
 * ticket workflow was unreachable in the shipped app; and ad review — despite `/api/ads/review`
 * being gated on `requireStaff` — had its only UI inside the owner console, which staff cannot
 * open. Staff held the permission with no door to walk through.
 *
 * One shell with one nav fixes all three, and gives the thing a name: a person promoted to staff
 * gets a place to go, not three URLs to be told about.
 *
 * ## Owners and the master still see this
 *
 * The ladder is `>=` (see lib/platformRole.ts), so OWNER and MASTER pass `isStaff`. That is
 * deliberate and stays: someone has to be able to clear the queue when no moderator is around.
 * What matters is that review happens in exactly ONE place — the owner console keeps revenue and
 * the pending-count health tile, and links here rather than growing a second review UI. Two review
 * surfaces would mean two standards and two paths into the same audit trail.
 *
 * ## Not the access control
 *
 * This gate decides what to render. Every `/api/staff/*` route independently enforces
 * `requireStaff`, so editing `platformRole` in your own client buys an empty page and a wall of
 * 403s, not anyone else's pending uploads.
 */

interface Section {
  to: string;
  label: string;
  icon: typeof ShieldCheck;
  /** Work waiting in that section. `undefined` while loading — a badge of 0 and a badge of
   *  "not known yet" must not look the same. */
  count?: number;
}

export function StaffLayout() {
  const user = useAuthStore((s) => s.user);

  // Queried at the shell so every tab carries a live "there is work here" badge. The video counts
  // endpoint already refetches on its own interval; the other two are cheap list reads that are
  // fetched anyway the moment their tab is opened, so this shares one cache entry rather than
  // adding traffic.
  const videoCounts = useStaffVideoCounts();
  const openTickets = useTickets("OPEN");
  const adQueue = useAdReviewQueue();

  if (!user) return null;
  if (!isStaff(user.platformRole)) return <Navigate to={APP_HOME} replace />;

  const sections: Section[] = [
    {
      to: "/staff/videos",
      label: "Videos",
      icon: Clapperboard,
      count: videoCounts.data?.PENDING_REVIEW,
    },
    // `counts.OPEN`, not the returned page length — the list is paginated, so its length would
    // silently cap the badge at a page size and read as "10 reports" forever.
    { to: "/staff/reports", label: "Reports", icon: Flag, count: openTickets.data?.counts?.OPEN },
    { to: "/staff/ads", label: "Ads", icon: Megaphone, count: adQueue.data?.length },
    { to: "/staff/audit", label: "Audit log", icon: ScrollText },
  ];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-base-900">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-base-800 px-4 py-3 short:py-2">
        <ShieldCheck className="h-5 w-5 shrink-0 text-accent" />
        <h1 className="font-display text-lg text-signal short:text-base">Staff suite</h1>
        <span className="ml-auto truncate text-xs text-signal-faint">
          Signed in as {user.displayName ?? user.username} · {(user.platformRole ?? "user").toLowerCase()}
        </span>
      </header>

      {/* Horizontally scrollable rather than wrapping: four sections plus badges overflow a narrow
          phone, and a nav that wraps to two lines eats a third of a landscape viewport. */}
      <nav className="scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-base-800 px-3 py-2">
        {sections.map(({ to, label, icon: Icon, count }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-white"
                  : "text-signal-dim hover:bg-base-700 hover:text-signal",
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
            {count !== undefined && count > 0 && (
              <span className="rounded-full bg-flare px-1.5 text-[10px] font-bold leading-4 text-white">
                {count > 99 ? "99+" : count}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
