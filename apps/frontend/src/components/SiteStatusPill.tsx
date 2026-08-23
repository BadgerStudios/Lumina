import { useSiteStats } from "../queries/site";

/**
 * The live status indicator for the marketing site — the pill that replaced the old static
 * "Self-hosted and running" text in the hero.
 *
 * Three states, exactly as asked:
 *   • green  — online: the server answered and reported normal operation
 *   • yellow — maintenance: the server answered and reported SITE_STATUS=maintenance
 *   • red    — offline: the request FAILED, so the backend is unreachable. This one can't be
 *              self-reported (a server that can answer is by definition not offline), so it's
 *              inferred here from the query error rather than read from the payload.
 *
 * The text carries the two live numbers the user wanted surfaced: total signups and how many
 * people are connected right now. While the first request is in flight it shows a neutral
 * "Connecting…" rather than guessing a colour.
 */
function fmt(n: number): string {
  return n.toLocaleString();
}

export function SiteStatusPill() {
  const { data, isError, isLoading } = useSiteStats();

  const state: "online" | "maintenance" | "offline" | "loading" = isLoading
    ? "loading"
    : isError || !data
      ? "offline"
      : data.status === "maintenance"
        ? "maintenance"
        : "online";

  const meta = {
    online: { dot: "#33d6a6", ring: "rgba(51,214,166,0.18)", label: "All systems online" },
    maintenance: { dot: "#f5b942", ring: "rgba(245,185,66,0.18)", label: "Under maintenance" },
    offline: { dot: "#ff5c72", ring: "rgba(255,92,114,0.18)", label: "Currently offline" },
    loading: { dot: "#7a6fa0", ring: "rgba(122,111,160,0.16)", label: "Connecting…" },
  }[state];

  const users = data?.totals.users ?? 0;
  const online = data?.totals.onlineNow ?? 0;

  return (
    <span className="inline-flex items-center gap-2.5 rounded-full border border-hairline bg-base-800/70 px-3.5 py-1.5 text-xs text-signal-dim backdrop-blur">
      <span className="relative flex h-2 w-2">
        {/* The soft pulse only runs when things are healthy — a red/yellow dot that pulsed would
            read as "working", which is the opposite of the message. */}
        {state === "online" && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ background: meta.dot }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: meta.dot, boxShadow: `0 0 0 4px ${meta.ring}` }} />
      </span>
      <span className="font-medium text-signal">{meta.label}</span>
      {state !== "loading" && state !== "offline" && (
        <>
          <span className="h-3 w-px bg-hairline" />
          <span>
            <span className="font-semibold text-signal">{fmt(users)}</span> signed up
          </span>
          <span className="hidden sm:inline">
            · <span className="font-semibold text-signal">{fmt(online)}</span> online now
          </span>
        </>
      )}
    </span>
  );
}
