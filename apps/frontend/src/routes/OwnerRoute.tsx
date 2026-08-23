import { APP_HOME } from "../lib/platform";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Crown,
  Loader2,
  Users,
  Activity,
  Gavel,
  UserCog,
  ServerCog,
  Megaphone,
  ShieldCheck,
  BadgeCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { usePlatformStats, useAttentionItems, usePlatformHealth, useEngagement } from "../queries/owner";
import { OwnerUsersPanel, OwnerBansPanel } from "../owner/OwnerPeoplePanels";
import { OwnerAgeReviewsPanel } from "../owner/OwnerAgeReviewsPanel";
import { TeamPanel } from "../owner/OwnerMasterPanels";
import { OwnerInfrastructurePanel } from "../owner/OwnerInfrastructurePanel";
import { OwnerAdsPanel } from "../owner/OwnerAdsPanel";
import { OwnerOfficialAccountsPanel } from "../owner/OwnerOfficialAccountsPanel";
import { RevenuePanel, DownloadsPanel, BandwidthPanel } from "../owner/OwnerBusinessPanels";
import { useAuthStore } from "../store/authStore";
import { isOwner, isMaster } from "../lib/platformRole";
import { cn } from "../lib/cn";

type Tab = "overview" | "users" | "bans" | "ageReviews" | "team" | "infrastructure" | "ads" | "official";

/**
 * Owner dashboard.
 *
 * The client-side role check decides what renders; it is not the access control. Every /api/owner
 * route independently enforces requireOwner, so forging this locally yields an empty page and 403s.
 */
export function OwnerRoute() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<Tab>("overview");
  const master = isMaster(user?.platformRole);

  if (!user) return null;
  if (!isOwner(user.platformRole)) return <Navigate to={APP_HOME} replace />;

  return (
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 bg-base-900">
      <div className="flex items-center gap-2 border-b border-hairline bg-base-800 px-4 py-3">
        <Crown className="h-5 w-5 text-amber" />
        <h1 className="font-display text-lg text-signal">Owner dashboard</h1>
      </div>

      <div className="flex gap-1 border-b border-hairline bg-base-800 px-3 py-2">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<Activity className="h-4 w-4" />}>
          Overview
        </TabButton>
        <TabButton active={tab === "users"} onClick={() => setTab("users")} icon={<Users className="h-4 w-4" />}>
          Users
        </TabButton>
        <TabButton active={tab === "bans"} onClick={() => setTab("bans")} icon={<Gavel className="h-4 w-4" />}>
          Bans &amp; appeals
        </TabButton>
        {/* Team management existed only in the standalone owner app, which meant appointing staff
            from a browser was impossible even though the API allowed it. Same component, so the
            two consoles cannot drift. */}
        <TabButton active={tab === "team"} onClick={() => setTab("team")} icon={<UserCog className="h-4 w-4" />}>
          Team &amp; access
        </TabButton>
        {/* Lumina Control. Everything here is a view over what the host agent reported — the app
            has no access to Docker and never will (see modules/ops for why). */}
        {/* MASTER only. Creating accounts the whole platform is told to trust is the most
            impersonation-sensitive power in the product, so it sits at the tier that can only be
            granted from the server's own environment. Hidden here AND enforced server-side —
            hiding a tab is presentation, never access control. */}
        {master && (
          <TabButton
            active={tab === "official"}
            onClick={() => setTab("official")}
            icon={<BadgeCheck className="h-4 w-4" />}
          >
            Official accounts
          </TabButton>
        )}
        <TabButton active={tab === "ageReviews"} onClick={() => setTab("ageReviews")} icon={<ShieldCheck className="h-4 w-4" />}>
          Age reviews
        </TabButton>
        <TabButton active={tab === "ads"} onClick={() => setTab("ads")} icon={<Megaphone className="h-4 w-4" />}>
          Ads
        </TabButton>
        <TabButton
          active={tab === "infrastructure"}
          onClick={() => setTab("infrastructure")}
          icon={<ServerCog className="h-4 w-4" />}
        >
          Infrastructure
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" && <OverviewPanel />}
        {tab === "users" && <OwnerUsersPanel />}
        {tab === "bans" && <OwnerBansPanel />}
        {tab === "ageReviews" && (
          <div className="mx-auto max-w-3xl">
            <OwnerAgeReviewsPanel />
          </div>
        )}
        {tab === "official" && master && (
          <div className="mx-auto max-w-3xl">
            <OwnerOfficialAccountsPanel />
          </div>
        )}
        {tab === "ads" && (
          <div className="mx-auto max-w-4xl">
            <OwnerAdsPanel />
          </div>
        )}
        {tab === "infrastructure" && (
          <div className="mx-auto max-w-5xl">
            <OwnerInfrastructurePanel />
          </div>
        )}
        {tab === "team" && (
          <div className="mx-auto max-w-4xl">
            <TeamPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition",
        active ? "bg-base-600 text-signal" : "text-signal-dim hover:text-signal",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * DAU/WAU + signup-cohort retention, straight off real activity (messages + session refreshes —
 * see the /owner/engagement route). Bars are plain divs scaled to the window max: honest at any
 * size, no chart library shipped for four numbers a day.
 */
function EngagementSection() {
  const { data } = useEngagement();
  if (!data) return null;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.users));
  const today = data.daily[data.daily.length - 1];
  const thisWeek = data.weekly[data.weekly.length - 1];

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">Engagement</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active today" value={today?.users ?? 0} sub="messaged or opened the app" />
        <StatCard label="Active this week" value={thisWeek?.users ?? 0} sub="WAU" />
      </div>
      <div className="mt-3 rounded-lg border border-hairline bg-base-800 p-4">
        <p className="mb-2 text-xs text-signal-faint">Daily active users, last 30 days</p>
        <div className="flex h-16 items-end gap-[2px]">
          {data.daily.map((d) => (
            <div
              key={d.day}
              title={`${d.day}: ${d.users}`}
              className="min-w-[3px] flex-1 rounded-t bg-accent/70"
              style={{ height: `${Math.max(6, (d.users / maxDaily) * 100)}%` }}
            />
          ))}
        </div>
      </div>
      {data.cohorts.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-hairline bg-base-800 p-4">
          <p className="mb-2 text-xs text-signal-faint">
            Signup cohorts — of each week's new users, how many came back in the following weeks
          </p>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-signal-faint">
                <th className="py-1 pr-3 font-medium">Week of</th>
                <th className="py-1 pr-3 font-medium">Signups</th>
                {[1, 2, 3, 4].map((w) => <th key={w} className="py-1 pr-3 font-medium">+{w}w</th>)}
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((c) => (
                <tr key={c.cohort} className="border-t border-hairline text-signal">
                  <td className="py-1 pr-3">{c.cohort}</td>
                  <td className="py-1 pr-3">{c.size}</td>
                  {c.weeks.map((n, i) => (
                    <td key={i} className="py-1 pr-3 text-signal-dim">
                      {c.size > 0 ? `${Math.round((n / c.size) * 100)}%` : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OverviewPanel() {
  const { data: stats, isLoading } = usePlatformStats();
  const { data: attention } = useAttentionItems();
  const { data: health } = usePlatformHealth();

  if (isLoading || !stats) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Needs attention comes first — it's the only part that implies action. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">
          Needs attention
        </h2>
        {attention && attention.items.length > 0 ? (
          <div className="space-y-2">
            {attention.items.map((item) => (
              <a
                key={item.kind}
                href={item.href}
                className="flex items-center gap-3 rounded-lg border border-hairline bg-base-800 px-4 py-3 hover:border-accent"
              >
                <AlertTriangle
                  className={cn(
                    "h-5 w-5",
                    item.severity === "action" ? "text-amber" : item.severity === "warn" ? "text-flare" : "text-signal-faint",
                  )}
                />
                <span className="flex-1 text-signal">{item.label}</span>
                <span className="text-sm text-signal-faint">Review →</span>
              </a>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-hairline bg-base-800 px-4 py-3 text-signal-dim">
            <CheckCircle2 className="h-5 w-5 text-pulse" />
            Nothing needs your attention right now.
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">Platform</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Users" value={stats.users.total} sub={`+${stats.users.newThisWeek} this week`} />
          <StatCard label="Servers" value={stats.servers.total} />
          <StatCard label="Messages" value={stats.messages.total} sub={`+${stats.messages.today} today`} />
          <StatCard
            label="Videos"
            value={stats.videos.total}
            sub={`${formatBytes(stats.videos.storedBytes)} stored`}
          />
        </div>
      </section>

      <EngagementSection />

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">Moderation</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Pending review" value={stats.videos.pendingReview} />
          <StatCard label="Open reports" value={stats.moderation.openReports} />
          <StatCard label="Pending appeals" value={stats.moderation.pendingAppeals} />
          <StatCard label="Active bans" value={stats.moderation.activeBans} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">
          System health
        </h2>
        {health ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <HealthCard label="Database" ok={health.database.ok} detail={`${health.database.latencyMs}ms`} />
              <HealthCard label="Redis" ok={health.redis.ok} detail={`${health.redis.latencyMs}ms`} />
              <HealthCard
                label="Transcode queue"
                ok={health.transcodeQueue.available && health.transcodeQueue.waiting < 20}
                detail={
                  health.transcodeQueue.available
                    ? `${health.transcodeQueue.waiting} waiting, ${health.transcodeQueue.active} active`
                    : "unreachable"
                }
              />
              <StatCard label="API uptime" value={formatUptime(health.uptimeSeconds)} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <StatCard
                label="API memory"
                value={formatBytes(health.memory.rssBytes)}
                sub={`host ${formatBytes(health.memory.systemTotalBytes - health.memory.systemFreeBytes)} / ${formatBytes(health.memory.systemTotalBytes)}`}
              />
              <StatCard label="Load average" value={health.loadAverage.map((n) => n.toFixed(2)).join("  ")} />
              {health.disk && (
                <StatCard
                  label="Disk free"
                  value={formatBytes(health.disk.freeBytes)}
                  sub={`of ${formatBytes(health.disk.totalBytes)}`}
                />
              )}
            </div>
            {health.transcodeQueue.failed > 0 && (
              <p className="text-sm text-flare">
                {health.transcodeQueue.failed} transcode job(s) have failed and were not retried.
              </p>
            )}
          </div>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
        )}
      </section>

      {/* Stated plainly rather than shown as an empty "Revenue: $0" tile, which would imply a
          billing system exists and is reporting zero. */}
      <RevenuePanel />
      <DownloadsPanel />
      <BandwidthPanel />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-base-800 p-3">
      <p className="text-xs uppercase tracking-wide text-signal-faint">{label}</p>
      <p className="mt-1 font-display text-xl text-signal">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-signal-faint">{sub}</p>}
    </div>
  );
}

function HealthCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-base-800 p-3">
      <p className="text-xs uppercase tracking-wide text-signal-faint">{label}</p>
      <p className={cn("mt-1 flex items-center gap-1.5 font-medium", ok ? "text-pulse" : "text-flare")}>
        {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {ok ? "OK" : "Problem"}
      </p>
      <p className="mt-0.5 text-xs text-signal-faint">{detail}</p>
    </div>
  );
}

