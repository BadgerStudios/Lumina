import { DollarSign, Download, Gauge, AlertCircle, Loader2 } from "lucide-react";
import { useBusinessMetrics, combinedDownloads, combinedDownloadSeries } from "../queries/owner";
import { relativeTime } from "../lib/relativeTime";
import { Sparkline, MiniBars } from "./Sparkline";

export function formatBytes(bytes: number): string {
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

/** Money is stored and transported in minor units and only ever divided for display — never held as
 * a float, where rounding drift in a ledger would be unacceptable. */
export function formatMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export function RevenuePanel() {
  const { data, isLoading } = useBusinessMetrics();

  if (isLoading || !data) return <PanelSpinner />;
  const r = data.revenue;

  // The distinction that matters most on this panel: a platform with no billing connected and a
  // platform earning nothing look identical if you only render the number.
  if (!r.configured) {
    return (
      <section className="space-y-3">
        <SectionHeading icon={<DollarSign className="h-4 w-4" />}>Revenue</SectionHeading>
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-hairline bg-base-800 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber" />
          <div>
            <p className="text-signal">No billing system is connected.</p>
            <p className="mt-1 text-sm text-signal-dim">
              Stripe keys aren't configured on the server, so there are no transactions to report.
              This isn't &ldquo;$0 earned&rdquo; — it's nothing being measured. Add
              <code className="mx-1 rounded bg-base-900 px-1 py-0.5 text-xs">STRIPE_SECRET_KEY</code>
              and
              <code className="mx-1 rounded bg-base-900 px-1 py-0.5 text-xs">STRIPE_WEBHOOK_SECRET</code>
              to the server's .env and this panel starts reporting real figures.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const values = r.series.map((s) => s.cents);

  return (
    <section className="space-y-3">
      <SectionHeading icon={<DollarSign className="h-4 w-4" />}>Revenue</SectionHeading>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Net all-time" value={formatMoney(r.netCents, r.currency)} />
        <StatTile label="Last 30 days" value={formatMoney(r.last30DaysCents, r.currency)} />
        <StatTile label="Gross" value={formatMoney(r.grossCents, r.currency)} />
        <StatTile
          label="Refunded"
          value={formatMoney(r.refundedCents, r.currency)}
          tone={r.refundedCents > 0 ? "warn" : "default"}
        />
      </div>
      <div className="rounded-xl border border-hairline bg-base-800 p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-xs uppercase tracking-wide text-signal-faint">Daily net, 30 days</p>
          <p className="text-xs text-signal-faint">{r.activeSubscriptions} active subscriptions</p>
        </div>
        <div className="text-pulse">
          <Sparkline values={values} height={56} />
        </div>
      </div>
    </section>
  );
}

export function DownloadsPanel() {
  const { data, isLoading } = useBusinessMetrics();
  if (isLoading || !data) return <PanelSpinner />;
  const d = data.downloads;
  const store = data.store;
  const installs = data.installs;
  const all = combinedDownloads(data);
  const siteBy = (p: string) => d.byPlatform.find((x) => x.platform === p)?.count ?? 0;
  const ghBy = (p: string) => store?.github.byPlatform.find((x) => x.platform === p)?.count ?? 0;
  // Per day, all sources stacked into one bar so the shape of the week reads at a glance.
  const daily = combinedDownloadSeries(data);

  return (
    <section className="space-y-3">
      <SectionHeading icon={<Download className="h-4 w-4" />}>App downloads</SectionHeading>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="All downloads" value={all.total.toLocaleString()} sub="site + GitHub + Google Play" />
        <StatTile label="Last 7 days" value={all.last7Days.toLocaleString()} />
        <StatTile
          label="Uninstalled, 30 days"
          value={installs ? installs.lostLast30Days.toLocaleString() : "—"}
          sub={installs ? `${installs.lostUsers30Days} user${installs.lostUsers30Days === 1 ? "" : "s"} lost the app` : undefined}
          tone={installs && installs.lostLast30Days > 0 ? "warn" : "default"}
        />
        <StatTile
          label="Installed now"
          value={installs ? installs.activeInstalls.filter((a) => a.app !== "owner").reduce((n, a) => n + a.count, 0).toLocaleString() : "—"}
          sub="with notifications registered"
        />
      </div>

      <div className="rounded-xl border border-hairline bg-base-800 p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-signal-faint">Downloads per day, all sources</p>
        <div className="text-accent">
          <MiniBars values={daily} height={56} />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <SourceCard title="Lumina site" note="Counted download links on the site (Windows counted from build 129).">
          <Line label="Total" value={d.total - siteBy("android-owner")} />
          <Line label="Last 7 days" value={d.last7Days} />
          <Line label="Android APK" value={siteBy("android")} />
          <Line label="Windows" value={siteBy("desktop-windows")} />
          <Line label="Linux" value={siteBy("desktop-linux")} />
          <Line label="Owner console APK" value={siteBy("android-owner")} muted />
        </SourceCard>

        <SourceCard
          title="GitHub releases"
          note={store?.github.updatedAt ? `${store.github.repo} · updated ${relativeTime(store.github.updatedAt)}` : "Not fetched yet — the worker checks hourly."}
        >
          <Line label="Total" value={(store?.github.total ?? 0)} />
          <Line label="Last 7 days" value={store?.github.last7Days ?? 0} />
          <Line label="Android APK" value={ghBy("android")} />
          <Line label="Windows" value={ghBy("desktop-windows")} />
          <Line label="Linux" value={ghBy("desktop-linux")} />
          <Line label="Owner console APK" value={ghBy("android-owner")} muted />
        </SourceCard>

        <SourceCard
          title="Google Play"
          note={
            store?.play.connected
              ? store.play.latestDay
                ? `Play report through ${store.play.latestDay}${store.play.updatedAt ? ` · fetched ${relativeTime(store.play.updatedAt)}` : ""}`
                : "Connected — waiting for the first report."
              : undefined
          }
        >
          {store?.play.connected ? (
            <>
              <Line label="Installs (reported)" value={store.play.installsTotal} />
              <Line label="Installs, 7 days" value={store.play.installsLast7Days} />
              <Line label="Uninstalls, 7 days" value={store.play.uninstallsLast7Days} />
              <Line label="Uninstalls, 30 days" value={store.play.uninstallsLast30Days} />
              <Line label="Active devices" value={store.play.activeInstalls ?? 0} />
            </>
          ) : (
            <p className="text-xs leading-relaxed text-signal-faint">
              Not connected. In Play Console → Users and permissions, invite{" "}
              {store?.play.serviceAccount ? (
                <span className="select-all font-mono text-signal-dim">{store.play.serviceAccount}</span>
              ) : (
                "a Google service account"
              )}{" "}
              with &ldquo;View app information and download bulk reports&rdquo;, then set PLAY_REPORTS_BUCKET to the bucket from
              Download reports → Statistics (Copy Cloud Storage URI).
            </p>
          )}
        </SourceCard>
      </div>

      <div className="rounded-xl border border-hairline bg-base-800 p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-signal-faint">Uninstalls per day</p>
        {installs?.tracking === false ? (
          <p className="text-xs text-signal-faint">Push (FCM) isn&apos;t configured, so uninstalls can&apos;t be seen.</p>
        ) : (
          <>
            <div className="text-amber">
              <MiniBars
                values={(installs?.series ?? []).map((s) => {
                  const st = store?.series.find((x) => x.date === s.date);
                  return s.lost + (st?.playUninstalls ?? 0);
                })}
                height={40}
              />
            </div>
            <p className="mt-2 text-xs text-signal-faint">
              An uninstall is seen when the app&apos;s push token stops working: checked on every notification and once a day
              for every device. Only phones that allowed notifications can be seen; a token FCM simply rotated is not counted.
              Google Play&apos;s own uninstall numbers are added when Play is connected.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function SourceCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-hairline bg-base-800 p-3">
      <p className="text-xs uppercase tracking-wide text-signal-faint">{title}</p>
      <div className="space-y-0.5">{children}</div>
      {note && <p className="pt-1 text-[11px] text-signal-faint">{note}</p>}
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between text-sm ${muted ? "text-signal-faint" : "text-signal"}`}>
      <span className="text-xs text-signal-dim">{label}</span>
      <span className="font-display">{value.toLocaleString()}</span>
    </div>
  );
}

export function BandwidthPanel() {
  const { data, isLoading } = useBusinessMetrics();
  if (isLoading || !data) return <PanelSpinner />;

  const days = data.bandwidth;
  const total = days.reduce((sum, d) => sum + d.total, 0);
  const video = days.reduce((sum, d) => sum + d.video, 0);
  const attachment = days.reduce((sum, d) => sum + d.attachment, 0);
  const download = days.reduce((sum, d) => sum + d.download, 0);
  const today = days[days.length - 1];

  return (
    <section className="space-y-3">
      <SectionHeading icon={<Gauge className="h-4 w-4" />}>Bandwidth served</SectionHeading>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="30-day total" value={formatBytes(total)} />
        <StatTile label="Today" value={formatBytes(today?.total ?? 0)} />
        <StatTile label="Video" value={formatBytes(video)} />
        <StatTile label="Attachments" value={formatBytes(attachment)} />
      </div>
      <div className="rounded-xl border border-hairline bg-base-800 p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-signal-faint">Daily egress, 30 days</p>
        <div className="text-aurora" style={{ color: "var(--aurora)" }}>
          <Sparkline values={days.map((d) => d.total)} height={56} />
        </div>
        <p className="mt-2 text-xs text-signal-faint">
          Releases account for {formatBytes(download)}. Video is metered per byte-range actually
          served, not per request.
        </p>
      </div>
    </section>
  );
}

export function SectionHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-signal-dim">
      {icon}
      {children}
    </h2>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "warn" | "good" | "bad";
}) {
  const toneClass =
    tone === "warn" ? "text-amber" : tone === "good" ? "text-pulse" : tone === "bad" ? "text-flare" : "text-signal";
  return (
    <div className="rounded-xl border border-hairline bg-base-800 p-3">
      <p className="truncate text-xs uppercase tracking-wide text-signal-faint">{label}</p>
      <p className={`mt-1 font-display text-lg ${toneClass}`}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-signal-faint">{sub}</p>}
    </div>
  );
}

function PanelSpinner() {
  return (
    <div className="flex justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
    </div>
  );
}
