import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldAlert, Gavel, Activity as ActivityIcon, Ban, Info, AlertTriangle } from "lucide-react";
import { api } from "../lib/apiClient";
import { UserAvatar } from "../components/common/UserAvatar";
import { Group, Metric, type StatusState } from "./OwnerChrome";
import { MiniBars } from "./Sparkline";
import { cn } from "../lib/cn";

interface ActivityEvent {
  id: string;
  kind: "flag" | "staff";
  at: string;
  code: string;
  severity: string;
  detail: string | null;
  active: boolean;
  subject: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  actor: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  /** Who/what a staff action was done to, e.g. "@someone". */
  target?: string | null;
}

const SEVERITY_ICON: Record<string, { icon: typeof Info; className: string }> = {
  INFO: { icon: Info, className: "text-signal-faint" },
  RESTRICTED: { icon: AlertTriangle, className: "text-amber" },
  SOFT_BLOCK: { icon: ShieldAlert, className: "text-amber" },
  HARD_BLOCK: { icon: Ban, className: "text-flare" },
};

/** "AGE_UNDER_MINIMUM" reads as shouting in a list; sentence case reads as a log. */
function humanise(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One timeline of everything that happened: system blocks and staff decisions together.
 *
 * Reading them merged is the point — a flag followed by the action taken on it is a single story,
 * and two separate lists make you reconstruct it by timestamp.
 */
export function OwnerActivityPanel() {
  const [filter, setFilter] = useState<"all" | "flag" | "staff">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["master", "activity", filter],
    queryFn: () =>
      api.get<{
        events: ActivityEvent[];
        series: Array<{ date: string; count: number }>;
        activeFlags: number;
        last14Days?: { flags: number; staffActions: number; hardBlocks: number };
      }>(
        `/master/activity${filter === "all" ? "" : `?kind=${filter}`}`,
      ),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  // The 14-day totals come from the server. Counting the rows on screen (the latest 80 of all time)
  // under a "Last 14 days" heading reported numbers that were neither.
  const flagCount = data.last14Days?.flags ?? data.events.filter((e) => e.kind === "flag").length;
  const staffCount = data.last14Days?.staffActions ?? data.events.filter((e) => e.kind === "staff").length;
  const blocks = data.last14Days?.hardBlocks ?? data.events.filter((e) => e.severity === "HARD_BLOCK").length;

  return (
    <div className="space-y-5">
      <Group label="Last 14 days">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Metric
            label="Latest events"
            sub="newest 80 below"
            value={data.events.length}
            trend={
              <div className="h-full text-accent">
                <MiniBars values={data.series.map((s) => s.count)} height={32} />
              </div>
            }
          />
          <Metric label="System flags" value={flagCount} />
          <Metric label="Staff actions" value={staffCount} />
          <Metric
            label="Open flags"
            sub="all time, still unresolved"
            value={data.activeFlags}
            state={(data.activeFlags > 0 ? "warn" : "good") as StatusState}
          />
        </div>
        {blocks > 0 && (
          <p className="mt-1 text-xs text-signal-faint">
            {blocks} hard block{blocks === 1 ? "" : "s"} in this window.
          </p>
        )}
      </Group>

      <div className="flex gap-1.5">
        {(
          [
            ["all", "Everything"],
            ["flag", "System flags"],
            ["staff", "Staff actions"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              "oc-panel px-3 py-1.5 text-xs font-medium transition",
              filter === key ? "border-[var(--accent)] text-signal" : "text-signal-dim hover:text-signal",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Group label="Timeline">
        {data.events.length === 0 ? (
          <p className="oc-panel p-4 text-sm text-signal-dim">Nothing recorded yet.</p>
        ) : (
          <div className="oc-panel divide-y divide-[var(--oc-line)]">
            {data.events.map((e) => {
              const meta = SEVERITY_ICON[e.severity] ?? SEVERITY_ICON.INFO;
              const Icon = e.kind === "staff" ? Gavel : meta.icon;
              const person = e.kind === "staff" ? e.actor : e.subject;
              return (
                <div key={e.id} className="flex items-start gap-3 p-3">
                  <Icon
                    className={cn("mt-0.5 h-4 w-4 shrink-0", e.kind === "staff" ? "text-aurora" : meta.className)}
                    style={e.kind === "staff" ? { color: "var(--oc-owner)" } : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-signal">
                      {humanise(e.code)}
                      {e.active && (
                        <span className="rounded-full bg-amber/20 px-1.5 text-[10px] uppercase text-amber">
                          open
                        </span>
                      )}
                    </p>
                    {e.detail && <p className="break-words text-xs text-signal-dim">{e.detail}</p>}
                    {e.target && <p className="text-xs text-signal-faint">→ {e.target}</p>}
                    {person && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-signal-faint">
                        <UserAvatar
                          avatarUrl={person.avatarUrl}
                          name={person.displayName ?? person.username}
                          size={16}
                        />
                        {e.kind === "staff" ? "by" : ""} @{person.username}
                      </p>
                    )}
                  </div>
                  <span className="oc-num shrink-0 text-xs text-signal-faint" title={new Date(e.at).toLocaleString()}>
                    {relativeTime(e.at)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Group>
    </div>
  );
}

export { ActivityIcon };
