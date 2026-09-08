import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { REPORT_REASONS, useReportContent, type ReportReasonCode } from "../../queries/contentReports";
import { reportError, toast } from "../../store/toastStore";

/** Report a user or a message. The one reporting surface that isn't feed-video-specific — opened
 * from the profile card (report user) and the message toolbar (report message) via
 * openModalWith("report", { targetType, targetId, label }). */
export function ContentReportModal() {
  const openModal = useUIStore((s) => s.openModal);
  const payload = useUIStore((s) => s.modalPayload) as
    | { targetType: "USER" | "MESSAGE"; targetId: string; label: string }
    | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "report" && !!payload;

  const [reason, setReason] = useState<ReportReasonCode>("HARASSMENT");
  const [details, setDetails] = useState("");
  const submit = useReportContent();

  // Reset the form each time the modal opens for a new target (mount-once keeps stale state).
  useEffect(() => {
    if (open) {
      setReason("HARASSMENT");
      setDetails("");
    }
  }, [open, payload?.targetId]);

  const noun = payload?.targetType === "MESSAGE" ? "message" : "user";

  async function onSubmit() {
    if (!payload) return;
    try {
      await submit.mutateAsync({
        targetType: payload.targetType,
        targetId: payload.targetId,
        reason,
        details: details.trim() || undefined,
      });
      toast.success("Report submitted. Our team will take a look.");
      closeModal();
    } catch (e) {
      reportError(e, "Couldn't submit that report.");
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title={`Report ${noun}`}>
      <div className="flex flex-col gap-3">
        {payload ? (
          <p className="text-sm text-signal-dim">
            Reporting {noun === "message" ? "a message from " : ""}
            <span className="font-medium text-signal">{payload.label}</span>. Reports are private.
          </p>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-signal-dim">Reason</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as ReportReasonCode)}
            className="rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none"
          >
            {REPORT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-signal-dim">Details (optional)</span>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value.slice(0, 1000))}
            rows={4}
            placeholder="Anything that helps us understand what happened."
            className="resize-none rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
          />
          <span className="self-end text-xs text-signal-faint">{details.length}/1000</span>
        </label>

        <div className="mt-1 flex justify-end gap-2">
          <button onClick={closeModal} className="rounded px-3 py-1.5 text-sm text-signal-dim hover:text-signal">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={submit.isPending}
            className="rounded bg-dnd px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {submit.isPending ? "Submitting…" : "Submit report"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
