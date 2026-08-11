import { DollarSign, Download, Gauge, AlertCircle, Loader2 } from "lucide-react";
import { useBusinessMetrics } from "../queries/owner";
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

  return (
    <section className="space-y-3">
      <SectionHeading icon={<Download className="h-4 w-4" />}>App downloads</SectionHeading>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total" value={d.total.toLocaleString()} />
        <StatTile label="Last 7 days" value={d.last7Days.toLocaleString()} />
        {d.byPlatform.slice(0, 2).map((p) => (
          <StatTile key={p.platform} label={p.platform} value={p.count.toLocaleString()} />
        ))}
      </div>
      <div className="rounded-xl border border-hairline bg-base-800 p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-signal-faint">Downloads per day</p>
        <div className="text-accent">
          <MiniBars values={d.series.map((s) => s.count)} height={56} />
        </div>
        {/* Stated rather than left to be inferred — the number is honest about what it counts. */}
        <p className="mt-2 text-xs text-signal-faint">
          Counts downloads started from the app's own download links. Files fetched directly from
          /downloads/ bypass the counter.
        </p>
      </div>
    </section>
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
