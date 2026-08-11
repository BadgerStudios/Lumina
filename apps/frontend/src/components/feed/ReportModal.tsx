import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import {
  useReportVideo,
  REPORT_REASON_LABELS,
  type ReportReason,
} from "../../queries/videoSocial";

const REASONS = (Object.keys(REPORT_REASON_LABELS) as ReportReason[]).map((value) => ({
  value,
  label: REPORT_REASON_LABELS[value],
}));

export function ReportModal({ video, onClose }: { video: VideoDTO | null; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useReportVideo();

  // Resync on open — this modal is reused across videos, so a previous report's selection would
  // otherwise carry over to the next one.
  useEffect(() => {
    if (video) {
      setReason(null);
      setDetails("");
      setDone(false);
      setError(null);
    }
  }, [video]);

  if (!video) return null;

  const submit = () => {
    if (!reason) return;
    setError(null);
    report.mutate(
      { videoId: video.id, reason, details: details.trim() || undefined },
      {
        onSuccess: () => setDone(true),
        // A duplicate report comes back as a 409 by design (one report per person per video), so
        // it's shown as information rather than a failure.
        onError: (err) => setError((err as Error).message),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-xl border border-hairline bg-base-800 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg text-signal">Report video</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-signal-faint hover:text-signal">
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="text-sm text-signal-dim">
              Thanks — this has been sent to the moderation team for review.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setReason(r.value)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                    reason === r.value
                      ? "bg-accent text-white"
                      : "text-signal-dim hover:bg-base-700 hover:text-signal"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <textarea
              aria-label="Extra details about this report"
              value={details}
              onChange={(e) => setDetails(e.target.value.slice(0, 500))}
              placeholder="Anything else we should know? (optional)"
              rows={2}
              className="w-full resize-none rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
            />

            {error && <p className="text-sm text-flare">{error}</p>}

            <button
              type="button"
              onClick={submit}
              disabled={!reason || report.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-flare px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {report.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit report
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
