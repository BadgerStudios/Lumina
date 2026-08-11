import { APP_HOME } from "../lib/platform";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Inbox, Trophy, Clock, Search, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import {
  useTickets,
  useLeaderboard,
  useClaimTicket,
  useReleaseTicket,
  useCompleteTicket,
  type Ticket,
  type TicketStatus,
} from "../queries/reports";
import { videoMediaUrl } from "../queries/videos";
import { useAuthStore } from "../store/authStore";
import { isStaff } from "../lib/platformRole";
import { UserAvatar } from "../components/common/UserAvatar";
import { StarRating } from "../components/common/StarRating";
import { SkeletonCard, SkeletonList } from "../components/common/Skeleton";
import { cn } from "../lib/cn";

const TABS: Array<{ key: TicketStatus | "ALL" | "BOARD"; label: string }> = [
  { key: "OPEN", label: "Open" },
  { key: "IN_PROGRESS", label: "In progress" },
  { key: "INVESTIGATING", label: "Investigating" },
  { key: "COMPLETED", label: "Completed" },
  { key: "DISMISSED", label: "Dismissed" },
  { key: "BOARD", label: "Leaderboard" },
];

const STATUS_STYLE: Record<TicketStatus, string> = {
  OPEN: "bg-amber/15 text-amber",
  IN_PROGRESS: "bg-accent/15 text-accent",
  INVESTIGATING: "bg-aurora/15 text-aurora",
  COMPLETED: "bg-pulse/15 text-pulse",
  DISMISSED: "bg-base-600 text-signal-faint",
};

function relative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function StaffTicketsRoute() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<TicketStatus | "ALL" | "BOARD">("OPEN");
  const { data } = useTickets(tab === "BOARD" ? "OPEN" : tab);

  if (!user) return null;
  if (!isStaff(user.platformRole)) return <Navigate to={APP_HOME} replace />;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-base-900">
      <header className="flex items-center gap-2 border-b border-hairline bg-base-800 px-4 py-3">
        <Inbox className="h-5 w-5 text-accent" />
        <h1 className="font-display text-lg text-signal">Reports</h1>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-hairline bg-base-800 px-3 py-2">
        {TABS.map((t) => {
          const count = t.key !== "BOARD" && t.key !== "ALL" ? data?.counts?.[t.key] : undefined;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "lm-press flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition",
                tab === t.key ? "bg-base-600 text-signal" : "text-signal-dim hover:text-signal",
              )}
            >
              {t.key === "BOARD" && <Trophy className="h-3.5 w-3.5" />}
              {t.label}
              {count ? (
                <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "BOARD" ? <Leaderboard /> : <TicketQueue status={tab} />}
      </div>
    </div>
  );
}

function TicketQueue({ status }: { status: TicketStatus | "ALL" }) {
  const { data, isLoading } = useTickets(status);

  if (isLoading) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!data || data.reports.length === 0) {
    return (
      <div className="lm-enter flex flex-col items-center justify-center gap-2 py-16 text-center">
        <CheckCircle2 className="h-10 w-10 text-pulse" />
        <p className="text-signal">Nothing here.</p>
        <p className="text-sm text-signal-faint">
          {status === "OPEN" ? "No reports waiting — the queue is clear." : "No tickets in this state."}
        </p>
      </div>
    );
  }

  return (
    <div className="lm-stagger mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
      {data.reports.map((t) => (
        <TicketCard key={t.id} ticket={t} />
      ))}
    </div>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  const me = useAuthStore((s) => s.user);
  const claim = useClaimTicket();
  const release = useReleaseTicket();
  const complete = useCompleteTicket();
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"none" | "complete" | "dismiss">("none");

  const src = videoMediaUrl(ticket.video.playbackUrl);
  const mine = ticket.assignedTo?.id === me?.id;
  const open = ticket.status === "OPEN";
  const working = ticket.status === "IN_PROGRESS" || ticket.status === "INVESTIGATING";
  const closed = ticket.status === "COMPLETED" || ticket.status === "DISMISSED";
  const busy = claim.isPending || release.isPending || complete.isPending;

  return (
    <div className="lm-lift overflow-hidden rounded-xl border border-hairline bg-base-800 hover:border-accent/40">
      <div className="relative aspect-video bg-black">
        {src ? (
          <video src={src} controls preload="metadata" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-signal-faint">
            No playable media
          </div>
        )}
        <span
          className={cn(
            "absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            STATUS_STYLE[ticket.status],
          )}
        >
          {ticket.status.replace("_", " ").toLowerCase()}
        </span>
        {/* Volume is the most useful signal on the card — one report and nine are very different
            levels of urgency, and that shouldn't require opening the ticket to discover. */}
        {ticket.totalReportsOnVideo > 1 && (
          <span className="absolute right-2 top-2 rounded-full bg-flare px-2 py-0.5 text-[10px] font-semibold text-white">
            {ticket.totalReportsOnVideo} reports
          </span>
        )}
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-signal">{ticket.reason.replace(/_/g, " ").toLowerCase()}</p>
            {ticket.details && <p className="text-xs text-signal-dim">{ticket.details}</p>}
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs text-signal-faint">
            <Clock className="h-3 w-3" />
            {relative(ticket.createdAt)}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-signal-faint">
          <UserAvatar
            avatarUrl={ticket.video.author?.avatarUrl ?? null}
            name={ticket.video.author?.displayName ?? ticket.video.author?.username ?? "?"}
            size={20}
          />
          <span className="truncate">
            uploaded by @{ticket.video.author?.username ?? "[deleted]"}
          </span>
        </div>

        {ticket.assignedTo && (
          <p className="flex items-center gap-1.5 text-xs text-signal-dim">
            <UserAvatar
              avatarUrl={ticket.assignedTo.avatarUrl}
              name={ticket.assignedTo.displayName ?? ticket.assignedTo.username}
              size={18}
            />
            {mine ? "You have this" : `@${ticket.assignedTo.username} is on this`}
          </p>
        )}

        {closed && ticket.resolutionNote && (
          <p className="rounded-lg bg-base-900 p-2 text-xs text-signal-dim">"{ticket.resolutionNote}"</p>
        )}

        {mode !== "none" && (
          <div className="lm-enter space-y-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 1000))}
              placeholder="What did you do, and why?"
              className="w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
            />
            <p className="text-xs text-signal-faint">The person who reported this will see your note.</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!note.trim() || busy}
                onClick={() =>
                  complete.mutate(
                    { id: ticket.id, outcome: mode === "complete" ? "COMPLETED" : "DISMISSED", note: note.trim() },
                    { onSuccess: () => { setMode("none"); setNote(""); } },
                  )
                }
                className="lm-press rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => { setMode("none"); setNote(""); }}
                className="lm-press rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === "none" && !closed && (
          <div className="flex flex-wrap gap-2">
            {open && (
              <button
                type="button"
                disabled={busy}
                onClick={() => claim.mutate({ id: ticket.id, status: "IN_PROGRESS" })}
                className="lm-press flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {claim.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Take it
              </button>
            )}
            {working && mine && (
              <>
                {ticket.status === "IN_PROGRESS" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => claim.mutate({ id: ticket.id, status: "INVESTIGATING" })}
                    className="lm-press flex items-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
                  >
                    <Search className="h-3.5 w-3.5" /> Investigating
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setMode("complete")}
                  className="lm-press flex items-center gap-1 rounded-lg bg-pulse px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setMode("dismiss")}
                  className="lm-press flex items-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" /> Dismiss
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => release.mutate({ id: ticket.id })}
                  className="lm-press rounded-lg px-2 py-1.5 text-xs text-signal-faint hover:text-signal disabled:opacity-50"
                >
                  Release
                </button>
              </>
            )}
            {working && !mine && (
              <p className="text-xs text-signal-faint">Assigned to someone else.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Leaderboard() {
  const { data, isLoading } = useLeaderboard(30);

  if (isLoading) return <SkeletonList rows={4} />;
  if (!data || data.leaderboard.length === 0) {
    return <p className="py-16 text-center text-signal-dim">No tickets resolved in the last 30 days.</p>;
  }

  const top = data.leaderboard[0]?.points || 1;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="text-xs text-signal-faint">
        Last {data.days} days. Points are the stars reporters gave. Resolved and dismissed counts are
        shown alongside deliberately — rating alone would reward agreeing with reporters over
        judging correctly, since a correct dismissal is scored by the person it disappointed.
      </p>

      <div className="lm-stagger space-y-2">
        {data.leaderboard.map((entry, i) => (
          <div
            key={entry.user.id}
            className="lm-lift rounded-xl border border-hairline bg-base-800 p-3 hover:border-accent/40"
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                  i === 0 ? "bg-amber text-black" : i === 1 ? "bg-base-500 text-signal" : i === 2 ? "bg-[#b06f3a] text-white" : "bg-base-600 text-signal-faint",
                )}
              >
                {i + 1}
              </span>
              <UserAvatar
                avatarUrl={entry.user.avatarUrl}
                name={entry.user.displayName ?? entry.user.username}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-signal">
                  {entry.user.displayName ?? entry.user.username}
                </p>
                <p className="text-xs text-signal-faint">
                  {entry.resolved} resolved · {entry.dismissed} dismissed
                  {entry.averageHandlingHours !== null ? ` · ~${entry.averageHandlingHours}h avg` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-lg text-signal">{entry.points}</p>
                <p className="text-[10px] uppercase tracking-wide text-signal-faint">points</p>
              </div>
            </div>

            {/* Bar is relative to the leader, so the gap between first and fifth is legible at a
                glance rather than requiring the numbers to be compared. */}
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-base-900">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${Math.max(4, (entry.points / top) * 100)}%` }}
              />
            </div>

            {entry.averageRating !== null && (
              <div className="mt-2 flex items-center gap-2">
                <StarRating value={Math.round(entry.averageRating)} size={13} />
                <span className="text-xs text-signal-faint">
                  {entry.averageRating} from {entry.ratedCount} rating{entry.ratedCount === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
