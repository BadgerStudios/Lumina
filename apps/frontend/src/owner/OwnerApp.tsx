import { useState } from "react";
import {
  Crown,
  LayoutDashboard,
  DollarSign,
  Download,
  Users,
  Gavel,
  Activity,
  Menu,
  X,
  KeyRound,
  Palette,
  Megaphone,
  ServerCog,
  BadgeCheck,
  UserCog,
  LogOut,
  Loader2,
  ShieldCheck,
  Palette as PaletteIcon,
  BookLock,
  Radio,
  Archive,
  Film,
  Image as ImageIcon,
  Flag,
} from "lucide-react";
import {
  usePlatformStats,
  useAttentionItems,
  usePlatformHealth,
  useBusinessMetrics,
} from "../queries/owner";
import {
  RevenuePanel,
  DownloadsPanel,
  BandwidthPanel,
  formatBytes,
  formatMoney,
} from "./OwnerBusinessPanels";
import { OwnerUsersPanel, OwnerBansPanel } from "./OwnerPeoplePanels";
import { OwnerAgeReviewsPanel } from "./OwnerAgeReviewsPanel";
import { TeamPanel, ConfigPanel, BrandKitPanel } from "./OwnerMasterPanels";
import { DesignLab } from "./designs/DesignLab";
import { OwnerReasonsPanel } from "./OwnerReasonsPanel";
import { OwnerActivityPanel } from "./OwnerActivityPanel";
// Added to BOTH consoles at once. The web owner console and this Android build render the same
// panel components precisely so they can't drift — a feature that exists in one and not the other
// is how "the app is missing things the website has" starts.
import { OwnerAdsPanel } from "./OwnerAdsPanel";
import { OwnerMotdPanel } from "./OwnerMotdPanel";
import { OwnerDuplicatesPanel } from "./OwnerDuplicatesPanel";
import { OwnerImagesPanel } from "./OwnerImagesPanel";
import { TicketQueue } from "../components/tickets/TicketQueue";
import { OwnerReviewModal } from "./OwnerReviewModal";
import { OwnerInfrastructurePanel } from "./OwnerInfrastructurePanel";
import { OwnerOfficialAccountsPanel } from "./OwnerOfficialAccountsPanel";
// The staff review queue, mounted as-is: one component for both consoles, so the owner reviews
// with the same player, tabs and decisions as staff, and the two can never drift apart.
import { StaffVideosRoute } from "../routes/StaffVideosRoute";
import { StaffTicketsRoute } from "../routes/StaffTicketsRoute";
import {
  Metric,
  Group,
  StatusStrip,
  ActionRow,
  StatusDot,
  type StatusState,
} from "./OwnerChrome";
import { Sparkline, MiniBars } from "./Sparkline";
import { UpdateBanner } from "../components/layout/UpdateBanner";
import { OwnerBuildTag } from "./OwnerBuildTag";
import { ToastHost } from "../components/common/ToastHost";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { useAuthStore } from "../store/authStore";
import { useLogout } from "../queries/auth";
import { cn } from "../lib/cn";
import type { PlatformRole } from "@lumina/shared";
import { isMaster as checkMaster, hasRole } from "../lib/platformRole";
import { ROLE_META } from "./roleMeta";
import "./ownerTheme.css";

type Section =
  | "overview"
  | "revenue"
  | "downloads"
  | "system"
  | "users"
  | "bans"
  | "team"
  | "config"
  | "brand"
  | "design"
  | "reasons"
  | "activity"
  | "ads"
  | "infrastructure"
  | "ageReviews"
  | "official"
  | "videos"
  | "motd"
  | "reports"
  | "duplicates"
  | "images"
  | "archive";

/**
 * Navigation, grouped by what you'd be doing rather than as one flat list.
 *
 * Nine destinations in a single column is a scan every time; three labelled groups of two to four
 * means you go to the right area by category first.
 *
 * `minRole` is the rung a section needs, and it MIRRORS the gate on the route that section calls —
 * the server enforces it, this only avoids offering a destination that would answer 403. Keeping
 * the two in step is the whole job: a section listed below its route's gate is a dead end, and one
 * listed above it is a surface somebody was meant to reach and cannot find. Sections with no
 * minRole sit at the console floor, which is ADMIN — moderators do not open the console at all
 * and work from the staff suite in the main app instead.
 */
const NAV_GROUPS: Array<{
  group: string;
  items: Array<{
    key: Section;
    label: string;
    icon: typeof LayoutDashboard;
    minRole?: PlatformRole;
  }>;
}> = [
  {
    group: "Platform",
    items: [
      { key: "overview", label: "Overview", icon: LayoutDashboard, minRole: "EXECUTIVE" },
      { key: "activity", label: "Activity", icon: Radio, minRole: "EXECUTIVE" },
      { key: "system", label: "System", icon: Activity, minRole: "OWNER" },
      { key: "infrastructure", label: "Infrastructure", icon: ServerCog, minRole: "OWNER" },
    ],
  },
  {
    group: "Business",
    items: [
      { key: "revenue", label: "Revenue", icon: DollarSign, minRole: "EXECUTIVE" },
      // Ad review is a moderation queue; the revenue it earns is not.
      { key: "ads", label: "Ads", icon: Megaphone, minRole: "MODERATOR" },
      { key: "motd", label: "Message of the day", icon: Megaphone, minRole: "EXECUTIVE" },
      { key: "downloads", label: "Downloads", icon: Download, minRole: "EXECUTIVE" },
    ],
  },
  {
    group: "People",
    items: [
      { key: "users", label: "Users", icon: Users, minRole: "ADMIN" },
      { key: "videos", label: "Videos", icon: Film },
      { key: "images", label: "Images", icon: ImageIcon },
      { key: "reports", label: "Tickets", icon: Flag },
      { key: "archive", label: "Ticket archive", icon: Archive },
      { key: "bans", label: "Bans & appeals", icon: Gavel, minRole: "ADMIN" },
      { key: "duplicates", label: "Linked accounts", icon: Users, minRole: "ADMIN" },
      { key: "ageReviews", label: "Age reviews", icon: ShieldCheck },
      // Appointing people is the one thing an admin does not inherit — see assignableRoles.
      { key: "team", label: "Team & access", icon: UserCog, minRole: "OWNER" },
      // Staff-visible: they are the ones answering "why am I blocked".
      { key: "reasons", label: "Block reasons", icon: BookLock },
    ],
  },
  {
    group: "Master",
    items: [
      {
        key: "official",
        label: "Official accounts",
        icon: BadgeCheck,
        minRole: "MASTER",
      },
      { key: "config", label: "Configuration", icon: KeyRound, minRole: "MASTER" },
      { key: "brand", label: "Brand kit", icon: Palette, minRole: "MASTER" },
      // Temporary: here to choose a redesign direction, and meant to be removed once one is picked
      // rather than drifting into a permanent feature.
      { key: "design", label: "Design lab", icon: PaletteIcon, minRole: "MASTER" },
    ],
  },
];

const SECTION_LABELS: Record<Section, string> = {
  overview: "Overview",
  revenue: "Revenue",
  downloads: "Downloads & bandwidth",
  system: "System",
  users: "Users",
  bans: "Bans & appeals",
  team: "Team & access",
  config: "Configuration",
  brand: "Brand kit",
  design: "Design lab — UI redesign concepts",
  reasons: "Block reasons & flags",
  activity: "Activity",
  ads: "Advertising",
  infrastructure: "Infrastructure — Lumina Control",
  ageReviews: "Age reviews",
  official: "Official accounts",
  videos: "Videos — review queue",
  motd: "Message of the day",
  reports: "Reports — user & message queue",
  duplicates: "Linked accounts — shared device or address",
  images: "Images — review queue",
  archive: "Ticket archive — everything closed",
};

export function OwnerApp() {
  // Null until chosen, rather than defaulting to "overview": overview needs EXECUTIVE, so a
  // moderator or admin would otherwise open the console on the one page they cannot load.
  const [chosen, setChosen] = useState<Section | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const role = user?.platformRole;
  const isMaster = checkMaster(role);
  const rank = role ? ROLE_META[role] : null;

  const { data: health, isFetching: healthFetching } = usePlatformHealth();
  const { data: attention } = useAttentionItems();

  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => hasRole(role, i.minRole ?? "ADMIN")),
  })).filter((g) => g.items.length > 0);

  // Falling back to the first section this person can actually open — and re-deriving it rather
  // than storing it — means a demotion mid-session lands somewhere valid instead of on a panel
  // that now 403s.
  const visible = groups.flatMap((g) => g.items.map((i) => i.key));
  const section: Section = chosen && visible.includes(chosen) ? chosen : (visible[0] ?? "overview");

  const go = (next: Section) => {
    setChosen(next);
    setNavOpen(false);
  };

  // Derived once here and passed down, so the strip and the System page can never disagree about
  // whether something is healthy.
  const statusItems: Array<{
    label: string;
    state: StatusState;
    detail?: string;
    /** Present on the Review chip, which is a way into the queues rather than only a number. */
    onClick?: () => void;
  }> = health
    ? [
        {
          label: "DB",
          state: health.database.ok ? "good" : "bad",
          detail: `${health.database.latencyMs}ms`,
        },
        {
          label: "Redis",
          state: health.redis.ok ? "good" : "bad",
          detail: `${health.redis.latencyMs}ms`,
        },
        {
          label: "Queue",
          state: !health.transcodeQueue.available
            ? "bad"
            : health.transcodeQueue.waiting > 20
              ? "warn"
              : "good",
          detail: health.transcodeQueue.available
            ? `${health.transcodeQueue.waiting}`
            : "down",
        },
        {
          label: "Review",
          state: (attention?.items.length ?? 0) > 0 ? "warn" : "good",
          detail: String(
            attention?.items.reduce((n, i) => n + i.count, 0) ?? 0,
          ),
          // The count was a number you could read and not act on: seeing "9" meant leaving the
          // page, finding the right section, and losing track of the other eight. Opening the
          // review window instead brings every queue to the count.
          onClick:
            (attention?.items.length ?? 0) > 0 ? () => setReviewing(true) : undefined,
        },
      ]
    : [{ label: "Connecting", state: "idle" }];

  return (
    // `oc-root` scopes the console's focus-visible ring (ownerTheme.css). Applied at the root
    // because the previous styles defined no focus indicator anywhere, and this screen has Ban and
    // role controls reachable by Tab — losing the caret next to those is dangerous, not just untidy.
    <div className="oc-root flex h-app overflow-hidden bg-[var(--oc-bg)] text-signal">
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/70 lg:hidden"
        />
      )}

      <aside
        className={cn(
          "z-40 flex w-60 shrink-0 flex-col border-r border-[var(--oc-line)] bg-[var(--oc-panel)]",
          "fixed inset-y-0 left-0 transition-transform lg:static lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
        // Bottom inset for the same reason as the top: the drawer spans the full height, so its
        // last nav item would otherwise sit under the gesture bar and be hard to tap.
        style={{ paddingBottom: "var(--safe-bottom)" }}
      >
        <div
          className="flex items-center gap-2.5 border-b border-[var(--oc-line)] px-4 pb-4"
          style={{ paddingTop: "calc(1rem + var(--safe-top))" }}
        >
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{
              background: `var(--oc-${rank?.tone ?? "staff"})`,
            }}
          >
            <Crown className="h-4 w-4 text-black" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-display text-sm leading-tight">
              Lumina
            </span>
            <span
              className="oc-label block leading-tight"
              style={{
                color: `var(--oc-${rank?.tone ?? "staff"})`,
              }}
            >
              {rank?.label ?? "Staff"}
            </span>
          </span>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
            className="ml-auto text-signal-faint lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto py-3">
          {groups.map((g) => (
            <div key={g.group}>
              <p className="oc-label px-4 pb-1.5">{g.group}</p>
              <div className="space-y-0.5">
                {g.items.map((item) => {
                  const Icon = item.icon;
                  const active = section === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-active={active}
                      onClick={() => go(item.key)}
                      className={cn(
                        "oc-nav-item flex w-full items-center gap-2.5 px-4 py-2 text-sm transition",
                        active
                          ? "bg-[var(--oc-panel-raised)] font-medium text-signal"
                          : "text-signal-dim hover:text-signal",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-[var(--oc-line)] p-3">
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="h-4 w-4 shrink-0"
              style={{
                color: `var(--oc-${rank?.tone ?? "staff"})`,
              }}
            />
            <p className="min-w-0 flex-1 truncate text-xs text-signal-dim">
              {user?.displayName ?? user?.username}
            </p>
          </div>
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-signal-faint hover:text-signal"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
          <OwnerBuildTag />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* owner.html sets viewport-fit=cover, so the WebView draws edge to edge and the OS status
            bar overlaps whatever is at y=0. The app already padded for the BOTTOM inset and never
            the top, which put the hamburger underneath the clock. Padding rather than a margin so
            the panel colour still fills the strip behind the status bar instead of leaving a gap. */}
        <header
          className="flex items-center gap-3 border-b border-[var(--oc-line)] bg-[var(--oc-panel)] px-4 pb-3"
          style={{ paddingTop: "calc(0.75rem + var(--safe-top))" }}
        >
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="lg:hidden"
          >
            <Menu className="h-5 w-5 text-signal" />
          </button>
          <h1 className="font-display text-base">{SECTION_LABELS[section]}</h1>
        </header>

        {/* Below the header rather than above it, so it never sits under the status bar — the
            header owns the safe-area inset and the banner would have to duplicate that padding to
            be readable at y=0. Renders nothing at all unless this build is genuinely older than
            the published one. */}
        <UpdateBanner />

        {/* Pinned under the header on every section — the answer to "is anything wrong" should not
            depend on which page happens to be open. */}
        <StatusStrip items={statusItems} updating={healthFetching} />

        <main
          className="min-h-0 flex-1 overflow-y-auto p-4"
          style={{
            paddingBottom: "calc(1.5rem + var(--safe-bottom))",
          }}
        >
          {/* Per-section rather than around the whole console: a panel that throws — a stat with an
              unexpected shape, a chart with no data — should leave the sidebar usable so you can
              switch to another section. Keyed by section, so switching clears the error by itself
              instead of latching until a reload. */}
          <ErrorBoundary resetKey={section} label={SECTION_LABELS[section]}>
            <div className="mx-auto max-w-6xl space-y-6">
              {section === "overview" && (
                <OverviewSection onNavigate={go} onReview={() => setReviewing(true)} />
              )}
              {section === "revenue" && <RevenuePanel />}
              {section === "downloads" && (
                <>
                  <DownloadsPanel />
                  <BandwidthPanel />
                </>
              )}
              {section === "system" && <SystemSection />}
              {section === "users" && <OwnerUsersPanel />}
              {section === "videos" && <StaffVideosRoute />}
              {section === "images" && <OwnerImagesPanel />}
              {/* The same queue the staff suite uses — see components/tickets/TicketQueue. */}
              {section === "reports" && <TicketQueue status="ACTIVE" />}
              {section === "archive" && <TicketQueue status="CLOSED" />}
              {section === "bans" && <OwnerBansPanel />}
              {section === "ageReviews" && <OwnerAgeReviewsPanel />}
              {section === "team" && <TeamPanel />}
              {section === "reasons" && <OwnerReasonsPanel />}
              {section === "activity" && <OwnerActivityPanel />}
              {section === "ads" && <OwnerAdsPanel />}
              {section === "motd" && <OwnerMotdPanel />}
              {section === "duplicates" && <OwnerDuplicatesPanel />}
              {section === "infrastructure" && <OwnerInfrastructurePanel />}
              {section === "official" && isMaster && (
                <OwnerOfficialAccountsPanel />
              )}
              {section === "config" && isMaster && <ConfigPanel />}
              {section === "brand" && isMaster && <BrandKitPanel />}
              {section === "design" && isMaster && <DesignLab />}
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {/* Fixed-position overlay, so it belongs at the root rather than inside the scrolling main. */}
      {reviewing && <OwnerReviewModal onClose={() => setReviewing(false)} />}

      <ToastHost />
    </div>
  );
}

function OverviewSection({
  onNavigate,
  onReview,
}: {
  onNavigate: (s: Section) => void;
  onReview: () => void;
}) {
  const { data: stats, isLoading } = usePlatformStats();
  const { data: attention } = useAttentionItems();
  const { data: business } = useBusinessMetrics();

  if (isLoading || !stats) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  /**
   * The server decides how loud each item is, alongside the count that justifies it. This used to
   * be re-derived here from the item's `kind`, which meant every new kind silently defaulted to
   * "warn" until someone remembered to come back and add it.
   */
  const severity = (level: string): StatusState =>
    level === "urgent" ? "bad" : level === "info" ? "idle" : "warn";

  return (
    <div className="space-y-6">
      {attention && attention.items.length > 0 && (
        <Group label="Needs attention">
          <div className="space-y-2">
            {attention.items.map((item) => (
              <ActionRow
                key={item.kind}
                label={item.label}
                state={severity(item.severity)}
                // Opens the review window rather than navigating. Going to the section works,
                // but it costs the list: you lose sight of everything else outstanding at the
                // moment you act on one of them. The window keeps all of it in front of you.
                onClick={onReview}
              />
            ))}
          </div>
        </Group>
      )}

      <Group label="Platform">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Metric
            label="Users"
            value={stats.users.total.toLocaleString()}
            sub={`+${stats.users.newThisWeek} this week`}
            trend={
              <div className="h-full text-accent">
                <Sparkline
                  values={stats.users.series.map((s) => s.count)}
                  height={32}
                />
              </div>
            }
            onClick={() => onNavigate("users")}
          />
          <Metric
            label="Online now"
            value={stats.users.online.toLocaleString()}
            sub={
              stats.users.total > 0
                ? `${Math.round((stats.users.online / stats.users.total) * 100)}% of ${stats.users.total.toLocaleString()}${
                    stats.users.onlineBots > 0 ? ` · ${stats.users.onlineBots} bot${stats.users.onlineBots === 1 ? "" : "s"}` : ""
                  }`
                : undefined
            }
          />
          <Metric
            label="Spaces"
            value={stats.servers.total.toLocaleString()}
            sub="created by members"
          />
          <Metric
            label="Messages"
            value={stats.messages.total.toLocaleString()}
            sub={`+${stats.messages.today} today`}
            trend={
              <div className="h-full" style={{ color: "var(--oc-good)" }}>
                <Sparkline
                  values={stats.messages.series.map((s) => s.count)}
                  height={32}
                />
              </div>
            }
          />
          <Metric
            label="Videos"
            value={stats.videos.total.toLocaleString()}
            sub={formatBytes(stats.videos.storedBytes)}
            trend={
              <div className="h-full" style={{ color: "var(--aurora)" }}>
                <MiniBars
                  values={stats.videos.series.map((s) => s.count)}
                  height={32}
                />
              </div>
            }
          />
        </div>
      </Group>

      <Group label="Business">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Metric
            label="Net revenue"
            value={
              business?.revenue.configured
                ? formatMoney(
                    business.revenue.netCents,
                    business.revenue.currency,
                  )
                : "—"
            }
            sub={
              business?.revenue.configured
                ? "all time"
                : "billing not connected"
            }
            state={business?.revenue.configured ? undefined : "idle"}
            trend={
              business?.revenue.configured ? (
                <div className="h-full text-pulse">
                  <Sparkline
                    values={business.revenue.series.map((s) => s.cents)}
                    height={32}
                  />
                </div>
              ) : undefined
            }
            onClick={() => onNavigate("revenue")}
          />
          <Metric
            label="Subscribers"
            value={business?.revenue.activeSubscriptions ?? 0}
            onClick={() => onNavigate("revenue")}
          />
          <Metric
            label="Downloads"
            value={(business?.downloads.total ?? 0).toLocaleString()}
            sub={`+${business?.downloads.last7Days ?? 0} this week`}
            trend={
              business ? (
                <div className="h-full text-accent">
                  <MiniBars
                    values={business.downloads.series.map((s) => s.count)}
                    height={32}
                  />
                </div>
              ) : undefined
            }
            onClick={() => onNavigate("downloads")}
          />
          <Metric
            label="Bandwidth 30d"
            value={formatBytes(
              business?.bandwidth.reduce((n, d) => n + d.total, 0) ?? 0,
            )}
            trend={
              business ? (
                <div className="h-full" style={{ color: "var(--aurora)" }}>
                  <Sparkline
                    values={business.bandwidth.map((d) => d.total)}
                    height={32}
                  />
                </div>
              ) : undefined
            }
            onClick={() => onNavigate("downloads")}
          />
        </div>
      </Group>

      <Group label="Moderation">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Metric
            label="Pending review"
            onClick={() => onNavigate("videos")}
            value={stats.videos.pendingReview}
            state={stats.videos.pendingReview > 0 ? "warn" : "good"}
          />
          <Metric
            label="Open reports"
            value={stats.moderation.openReports}
            state={stats.moderation.openReports > 0 ? "bad" : "good"}
          />
          <Metric
            label="Appeals"
            value={stats.moderation.pendingAppeals}
            state={stats.moderation.pendingAppeals > 0 ? "bad" : "good"}
            onClick={() => onNavigate("bans")}
          />
          <Metric
            label="Active bans"
            value={stats.moderation.activeBans}
            onClick={() => onNavigate("bans")}
          />
          <Metric
            label="Age blocks"
            value={stats.moderation.ageBlocks}
            sub="under-18 signups refused"
            onClick={() => onNavigate("activity")}
          />
        </div>
      </Group>
    </div>
  );
}

function SystemSection() {
  const { data: health } = usePlatformHealth();

  if (!health) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  const uptime = (() => {
    const d = Math.floor(health.uptimeSeconds / 86400);
    const h = Math.floor((health.uptimeSeconds % 86400) / 3600);
    const m = Math.floor((health.uptimeSeconds % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();

  const diskUsedPct = health.disk
    ? Math.round(
        ((health.disk.totalBytes - health.disk.freeBytes) /
          health.disk.totalBytes) *
          100,
      )
    : null;

  return (
    <div className="space-y-6">
      <Group label="Services">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Metric
            label="Database"
            value={health.database.ok ? "OK" : "Down"}
            sub={`${health.database.latencyMs}ms`}
            state={health.database.ok ? "good" : "bad"}
          />
          <Metric
            label="Redis"
            value={health.redis.ok ? "OK" : "Down"}
            sub={`${health.redis.latencyMs}ms`}
            state={health.redis.ok ? "good" : "bad"}
          />
          <Metric
            label="Transcode queue"
            value={
              health.transcodeQueue.available
                ? health.transcodeQueue.waiting
                : "Down"
            }
            sub={
              health.transcodeQueue.available
                ? `${health.transcodeQueue.active} active · ${health.transcodeQueue.failed} failed`
                : "worker unreachable"
            }
            state={
              !health.transcodeQueue.available
                ? "bad"
                : health.transcodeQueue.waiting > 20 ||
                    health.transcodeQueue.failed > 0
                  ? "warn"
                  : "good"
            }
          />
          <Metric label="API uptime" value={uptime} />
        </div>
      </Group>

      <Group label="Resources">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
          <Metric
            label="API memory"
            value={formatBytes(health.memory.rssBytes)}
            sub={`host ${formatBytes(health.memory.systemTotalBytes - health.memory.systemFreeBytes)} / ${formatBytes(health.memory.systemTotalBytes)}`}
          />
          <Metric
            label="Load average"
            value={health.loadAverage.map((n) => n.toFixed(2)).join("  ")}
          />
          {health.disk && (
            <Metric
              label="Disk free"
              value={formatBytes(health.disk.freeBytes)}
              sub={`${diskUsedPct}% used`}
              // Video storage grows faster than anything else here, so a filling disk is the failure
              // most worth surfacing before it happens rather than after.
              state={
                diskUsedPct !== null && diskUsedPct > 85
                  ? "bad"
                  : diskUsedPct !== null && diskUsedPct > 70
                    ? "warn"
                    : "good"
              }
            />
          )}
        </div>
        {diskUsedPct !== null && diskUsedPct > 70 && (
          <p className="flex items-center gap-2 text-xs text-amber">
            <StatusDot state={diskUsedPct > 85 ? "bad" : "warn"} />
            Uploads are the fastest-growing thing on this host and there are no
            automated backups yet.
          </p>
        )}
      </Group>

      <BandwidthPanel />
    </div>
  );
}
