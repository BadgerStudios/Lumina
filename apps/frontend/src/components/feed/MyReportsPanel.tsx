import { useState } from "react";
import { Loader2, Clock, Search, CheckCircle2, XCircle, Star } from "lucide-react";
import { useMyReports, useRateReport, type MyReport, type TicketStatus } from "../../queries/reports";
import { REPORT_REASON_LABELS, type ReportReason } from "../../queries/videoSocial";
import { cn } from "../../lib/cn";

/**
 * The reporter's side of the ticket workflow.
 *
 * The backend has always been able to tell someone what happened to their report and to take a
 * 1-5 star rating for it, but nothing in any client called either route — which left the staff
 * leaderboard ranking people by points that no user had any way to award. This panel closes that
 * loop; it is the only place a rating can come from.
 */
export function MyReportsPanel() {
  const { data, isLoading } = useMyReports();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  const reports = data?.reports ?? [];
  if (reports.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-signal-dim">
        You haven't reported anything. If you do, this is where you'll see what came of it.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-base-900 p-4">
      <div className="mx-auto max-w-2xl space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </div>
    </div>
  );
}

const STATUS_META: Record<TicketStatus, { label: string; icon: React.ReactNode; className: string }> = {
  OPEN: {
    label: "Waiting for review",
    icon: <Clock className="h-3.5 w-3.5" />,
    className: "text-signal-dim",
  },
  IN_PROGRESS: {
    label: "Being handled",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    className: "text-amber",
  },
  INVESTIGATING: {
    label: "Under investigation",
    icon: <Search className="h-3.5 w-3.5" />,
    className: "text-amber",
  },
  COMPLETED: {
    label: "Action taken",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    className: "text-pulse",
  },
  DISMISSED: {
    label: "Closed with no action",
    icon: <XCircle className="h-3.5 w-3.5" />,
    className: "text-signal-dim",
  },
};

function ReportCard({ report }: { report: MyReport }) {
  const meta = STATUS_META[report.status];
  const closed = report.status === "COMPLETED" || report.status === "DISMISSED";

  return (
    <div className="rounded-lg border border-hairline bg-base-800 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className={cn("flex items-center gap-1.5 text-xs font-medium", meta.className)}>
          {meta.icon}
          {meta.label}
        </div>
        <span className="text-xs text-signal-faint">
          {new Date(report.createdAt).toLocaleDateString()}
        </span>
      </div>

      <p className="mt-1.5 text-sm text-signal">
        {REPORT_REASON_LABELS[report.reason as ReportReason] ?? report.reason}
      </p>

      {report.resolutionNote && (
        <p className="mt-1.5 rounded-md bg-base-900 p-2 text-xs text-signal-dim">
          {report.resolutionNote}
        </p>
      )}

      {/* Dismissed still gets a rating prompt: a correct refusal is work too, and hiding the
          prompt on dismissals would leave the leaderboard scoring only agreeable outcomes. */}
      {closed && <RatingRow report={report} />}
    </div>
  );
}

function RatingRow({ report }: { report: MyReport }) {
  const rate = useRateReport();
  const [hovered, setHovered] = useState(0);

  if (report.rating !== null) {
    return (
      <div className="mt-2 flex items-center gap-1 border-t border-hairline pt-2">
        <span className="mr-1 text-xs text-signal-faint">You rated this</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={cn(
              "h-4 w-4",
              n <= report.rating! ? "fill-amber text-amber" : "text-signal-faint",
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-hairline pt-2">
      <div className="flex items-center gap-1" onMouseLeave={() => setHovered(0)}>
        <span className="mr-1 text-xs text-signal-faint">How was this handled?</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Rate report ${report.id} ${n} star${n === 1 ? "" : "s"}`}
            disabled={rate.isPending}
            onMouseEnter={() => setHovered(n)}
            onClick={() => rate.mutate({ id: report.id, rating: n })}
            className="disabled:opacity-50"
          >
            <Star
              className={cn(
                "h-4 w-4 transition",
                n <= hovered ? "fill-amber text-amber" : "text-signal-faint hover:text-amber",
              )}
            />
          </button>
        ))}
      </div>
      {/* A rating can't be changed, so say so before the click rather than after. */}
      <p className="mt-1 text-[11px] text-signal-faint">Ratings are final and can't be changed.</p>
      {rate.isError && (
        <p className="mt-1 text-xs text-flare">{(rate.error as Error).message}</p>
      )}
    </div>
  );
}
