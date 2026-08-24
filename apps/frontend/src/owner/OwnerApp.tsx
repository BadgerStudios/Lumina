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
import { OwnerInfrastructurePanel } from "./OwnerInfrastructurePanel";
import { OwnerOfficialAccountsPanel } from "./OwnerOfficialAccountsPanel";
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
import { ToastHost } from "../components/common/ToastHost";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { useAuthStore } from "../store/authStore";
import { useLogout } from "../queries/auth";
import { cn } from "../lib/cn";
import { isMaster as checkMaster } from "../lib/platformRole";
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
  | "official";

/**
 * Navigation, grouped by what you'd be doing rather than as one flat list.
 *
 * Nine destinations in a single column is a scan every time; three labelled groups of two to four
 * means you go to the right area by category first. `master: true` marks a section only the master
 * account sees — the server enforces the same on every /api/master route.
 */
const NAV_GROUPS: Array<{
  group: string;
  items: Array<{
    key: Section;
    label: string;
    icon: typeof LayoutDashboard;
    master?: boolean;
  }>;
}> = [
  {
    group: "Platform",
    items: [
      { key: "overview", label: "Overview", icon: LayoutDashboard },
      { key: "activity", label: "Activity", icon: Radio },
      { key: "system", label: "System", icon: Activity },
      { key: "infrastructure", label: "Infrastructure", icon: ServerCog },
    ],
  },
  {
    group: "Business",
    items: [
      { key: "revenue", label: "Revenue", icon: DollarSign },
      { key: "ads", label: "Ads", icon: Megaphone },
      { key: "downloads", label: "Downloads", icon: Download },
    ],
  },
  {
    group: "People",
    items: [
      { key: "users", label: "Users", icon: Users },
      { key: "bans", label: "Bans & appeals", icon: Gavel },
      { key: "ageReviews", label: "Age reviews", icon: ShieldCheck },
      { key: "team", label: "Team & access", icon: UserCog },
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
        master: true,
      },
      { key: "config", label: "Configuration", icon: KeyRound, master: true },
      { key: "brand", label: "Brand kit", icon: Palette, master: true },
      // Temporary: here to choose a redesign direction, and meant to be removed once one is picked
      // rather than drifting into a permanent feature.
      { key: "design", label: "Design lab", icon: PaletteIcon, master: true },
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
};

export function OwnerApp() {
  const [section, setSection] = useState<Section>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const isMaster = checkMaster(user?.platformRole);

  const { data: health, isFetching: healthFetching } = usePlatformHealth();
  const { data: attention } = useAttentionItems();

  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.master || isMaster),
  })).filter((g) => g.items.length > 0);

  const go = (next: Section) => {
    setSection(next);
    setNavOpen(false);
  };

  // Derived once here and passed down, so the strip and the System page can never disagree about
  // whether something is healthy.
  const statusItems: Array<{
    label: string;
    state: StatusState;
    detail?: string;
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
              background: isMaster ? "var(--oc-master)" : "var(--oc-owner)",
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
                color: isMaster ? "var(--oc-master)" : "var(--oc-owner)",
              }}
            >
              {isMaster ? "Master" : "Owner"}
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
                color: isMaster ? "var(--oc-master)" : "var(--oc-owner)",
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
              {section === "overview" && <OverviewSection onNavigate={go} />}
              {section === "revenue" && <RevenuePanel />}
              {section === "downloads" && (
                <>
                  <DownloadsPanel />
                  <BandwidthPanel />
                </>
              )}
              {section === "system" && <SystemSection />}
              {section === "users" && <OwnerUsersPanel />}
              {section === "bans" && <OwnerBansPanel />}
              {section === "ageReviews" && <OwnerAgeReviewsPanel />}
              {section === "team" && <TeamPanel />}
              {section === "reasons" && <OwnerReasonsPanel />}
              {section === "activity" && <OwnerActivityPanel />}
              {section === "ads" && <OwnerAdsPanel />}
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
      <ToastHost />
    </div>
  );
}

function OverviewSection({ onNavigate }: { onNavigate: (s: Section) => void }) {
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

  const severity = (kind: string): StatusState =>
    kind === "reports" || kind === "appeals"
      ? "bad"
      : kind === "failed_transcodes"
        ? "idle"
        : "warn";

  return (
    <div className="space-y-6">
      {attention && attention.items.length > 0 && (
        <Group label="Needs attention">
          <div className="space-y-2">
            {attention.items.map((item) => (
              <ActionRow
                key={item.kind}
                label={item.label}
                state={severity(item.kind)}
                onClick={() =>
                  onNavigate(item.kind === "appeals" ? "bans" : "system")
                }
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
