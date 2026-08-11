import { useState } from "react";
import { Server, RotateCw, Play, Square, AlertTriangle, CheckCircle2, Loader2, WifiOff } from "lucide-react";
import { useOpsStatus, useOpsHistory, useOpsCommand, type OpsContainer } from "../queries/ops";
import { cn } from "../lib/cn";

/**
 * Lumina Control — the infrastructure tab of the owner console.
 *
 * Reads a snapshot the host agent pushed (see services/lumina-agent). The app itself has no access
 * to Docker and never will; this is a view over what the agent chose to report, and every button
 * queues a request the agent may decline.
 */

/** Restarting the database from a web page is a foot-gun with no upside, so postgres is absent
 * from the server's allowlist and therefore has no buttons here either. */
const CONTROLLABLE = new Set(["backend", "worker", "frontend", "redis", "coturn"]);

export function OwnerInfrastructurePanel() {
  const { data, isLoading } = useOpsStatus();
  const history = useOpsHistory(6);
  const command = useOpsCommand();
  const [confirming, setConfirming] = useState<{ action: "restart" | "stop" | "start"; target: string } | null>(null);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  // The agent not running is the normal state until someone installs it, so this explains itself
  // rather than rendering an empty dashboard that looks broken.
  if (!data?.snapshot) {
    return (
      <div className="rounded-lg border border-hairline bg-base-800 p-6 text-center">
        <WifiOff className="mx-auto mb-3 h-8 w-8 text-signal-faint" />
        <p className="text-signal">The control agent isn't reporting yet.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-signal-dim">
          Lumina Control runs as a small service on the host, outside the containers. Install it with{" "}
          <code className="rounded bg-base-900 px-1 py-0.5 text-xs">systemctl --user enable --now lumina-agent</code>{" "}
          and this page fills in within a minute.
        </p>
      </div>
    );
  }

  const { snapshot, agentOnline, lastSeenAt } = data;
  const memUsed = snapshot.host.memTotalBytes - snapshot.host.memAvailableBytes;
  const memPercent = (memUsed / snapshot.host.memTotalBytes) * 100;
  const diskPercent =
    snapshot.host.diskTotalBytes && snapshot.host.diskFreeBytes !== null
      ? ((snapshot.host.diskTotalBytes - snapshot.host.diskFreeBytes) / snapshot.host.diskTotalBytes) * 100
      : null;

  return (
    <div className="flex flex-col gap-4">
      {!agentOnline && (
        // Stale data is shown, but never silently: an old snapshot rendered as current is the one
        // failure this whole design exists to avoid.
        <div className="flex items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            The agent has stopped reporting — everything below is from{" "}
            {lastSeenAt ? new Date(lastSeenAt).toLocaleString() : "an earlier snapshot"}.
          </span>
        </div>
      )}

      {snapshot.dockerError && (
        <div className="flex items-center gap-2 rounded-lg border border-dnd/40 bg-dnd/10 px-3 py-2 text-sm text-dnd">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>The agent is running but can't reach Docker: {snapshot.dockerError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Host" value={snapshot.host.hostname} detail={`up ${formatDuration(snapshot.host.uptimeSeconds)}`} />
        <Metric
          label="Load"
          value={snapshot.host.loadAverage.map((n) => n.toFixed(2)).join("  ")}
          detail={`${snapshot.host.cpuCount} cores`}
          // Load is only meaningful against core count — 4.0 is saturated on 4 cores and idle on 32.
          warn={(snapshot.host.loadAverage[0] ?? 0) > snapshot.host.cpuCount}
        />
        <Metric
          label="Memory"
          value={`${memPercent.toFixed(0)}%`}
          detail={`${formatBytes(memUsed)} of ${formatBytes(snapshot.host.memTotalBytes)}`}
          warn={memPercent > 88}
        />
        <Metric
          label="Disk"
          value={diskPercent === null ? "—" : `${diskPercent.toFixed(0)}%`}
          detail={
            snapshot.host.diskFreeBytes !== null ? `${formatBytes(snapshot.host.diskFreeBytes)} free` : "unavailable"
          }
          warn={diskPercent !== null && diskPercent > 90}
        />
      </div>

      <Sparkline points={history.data?.points ?? []} />

      <div className="grid gap-3 md:grid-cols-2">
        {snapshot.containers.map((c) => (
          <ServiceCard
            key={c.name}
            container={c}
            busy={command.isPending}
            onAction={(action) => setConfirming({ action, target: c.service })}
          />
        ))}
      </div>

      {data.commands.length > 0 && (
        <div className="rounded-lg border border-hairline bg-base-800 p-3">
          <h3 className="mb-2 text-xs font-bold uppercase text-signal-dim">Recent actions</h3>
          <ul className="flex flex-col gap-1.5">
            {data.commands.slice(0, 8).map((c) => (
              <li key={c.id} className="flex items-baseline gap-2 text-xs">
                <span className={cn("font-medium", STATUS_TONE[c.status] ?? "text-signal-dim")}>{c.status}</span>
                <span className="text-signal">
                  {c.action} {c.target}
                </span>
                <span className="text-signal-faint">
                  by {c.requestedBy?.displayName ?? c.requestedBy?.username ?? "—"} ·{" "}
                  {new Date(c.createdAt).toLocaleTimeString()}
                </span>
                {c.result && <span className="truncate text-signal-faint">— {c.result.slice(0, 80)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming && (
        // Deliberately a confirmation and not a one-click action: "stop frontend" from a phone is
        // an outage, and the person doing it should have to read the sentence describing it.
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-lg bg-base-800 p-4 shadow-xl">
            <h3 className="text-base font-semibold text-signal">
              {confirming.action} {confirming.target}?
            </h3>
            <p className="mt-2 text-sm text-signal-dim">
              {confirming.action === "restart"
                ? `${confirming.target} will be unavailable for a few seconds.`
                : confirming.action === "stop"
                  ? `${confirming.target} will stay down until you start it again.`
                  : `${confirming.target} will be started.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded px-3 py-1.5 text-sm text-signal-dim hover:bg-base-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  command.mutate(confirming);
                  setConfirming(null);
                }}
                className="rounded bg-dnd px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Yes, {confirming.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  SUCCEEDED: "text-online",
  FAILED: "text-dnd",
  EXPIRED: "text-signal-faint",
  RUNNING: "text-amber",
  QUEUED: "text-signal-dim",
};

function ServiceCard({
  container,
  busy,
  onAction,
}: {
  container: OpsContainer;
  busy: boolean;
  onAction: (action: "restart" | "stop" | "start") => void;
}) {
  const running = container.state === "running";
  // Three states, not two. A service with no healthcheck declared is neither healthy nor
  // unhealthy, and painting it red would train everyone to ignore red.
  const unhealthy = container.health === "unhealthy" || !running;
  const memPercent =
    container.memBytes && container.memLimitBytes ? (container.memBytes / container.memLimitBytes) * 100 : null;

  return (
    <div className="rounded-lg border border-hairline bg-base-800 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {unhealthy ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-dnd" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-online" />
            )}
            <span className="truncate font-medium text-signal">{container.service}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-signal-faint">
            {container.status || container.state}
            {container.health ? ` · ${container.health}` : " · no healthcheck"}
          </p>
        </div>
        <Server className="h-4 w-4 shrink-0 text-signal-faint" />
      </div>

      <div className="mt-2 flex gap-4 text-xs text-signal-dim">
        <span>CPU {container.cpuPercent !== null ? `${container.cpuPercent.toFixed(1)}%` : "—"}</span>
        <span>
          MEM {container.memBytes !== null ? formatBytes(container.memBytes) : "—"}
          {memPercent !== null && ` (${memPercent.toFixed(0)}%)`}
        </span>
      </div>

      {CONTROLLABLE.has(container.service) && (
        <div className="mt-3 flex gap-1.5">
          <ActionButton icon={<RotateCw className="h-3 w-3" />} label="Restart" disabled={busy} onClick={() => onAction("restart")} />
          {running ? (
            <ActionButton icon={<Square className="h-3 w-3" />} label="Stop" disabled={busy} onClick={() => onAction("stop")} />
          ) : (
            <ActionButton icon={<Play className="h-3 w-3" />} label="Start" disabled={busy} onClick={() => onAction("start")} />
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded bg-base-700 px-2 py-1 text-xs font-medium text-signal hover:bg-base-600 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value, detail, warn }: { label: string; value: string; detail: string; warn?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-base-800 p-3", warn ? "border-amber/50" : "border-hairline")}>
      <div className="text-xs font-bold uppercase text-signal-dim">{label}</div>
      <div className={cn("mt-1 truncate text-lg font-semibold", warn ? "text-amber" : "text-signal")}>{value}</div>
      <div className="truncate text-xs text-signal-faint">{detail}</div>
    </div>
  );
}

/**
 * Six hours of load and memory as one inline SVG.
 *
 * Hand-drawn rather than pulling in a charting library for two lines — the whole point of the panel
 * is answering "was it like this an hour ago", and that needs shape, not axes and tooltips.
 */
function Sparkline({ points }: { points: Array<{ at: string; load1: number; memPercent: number }> }) {
  if (points.length < 2) return null;

  const W = 600;
  const H = 60;
  const maxLoad = Math.max(1, ...points.map((p) => p.load1));
  const path = (get: (p: (typeof points)[number]) => number, max: number) =>
    points
      .map((p, i) => {
        const x = (i / (points.length - 1)) * W;
        const y = H - (Math.min(max, get(p)) / max) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div className="rounded-lg border border-hairline bg-base-800 p-3">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-bold uppercase text-signal-dim">Last 6 hours</span>
        <span className="flex gap-3 text-signal-faint">
          <span className="text-accent">load</span>
          <span className="text-online">memory</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Host load and memory over the last six hours">
        <path d={path((p) => p.load1, maxLoad)} fill="none" stroke="currentColor" className="text-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={path((p) => p.memPercent, 100)} fill="none" stroke="currentColor" className="text-online" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
