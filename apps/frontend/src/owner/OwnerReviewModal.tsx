import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { useAttentionItems } from "../queries/owner";
import { StatusDot } from "./OwnerChrome";
import { TicketQueue } from "../components/tickets/TicketQueue";
import { OwnerImagesPanel } from "./OwnerImagesPanel";
import { OwnerBansPanel } from "./OwnerPeoplePanels";
import { OwnerAgeReviewsPanel } from "./OwnerAgeReviewsPanel";
import { OwnerReasonsPanel } from "./OwnerReasonsPanel";
import { OwnerDuplicatesPanel } from "./OwnerDuplicatesPanel";
import { StaffVideosRoute } from "../routes/StaffVideosRoute";
import type { StatusState } from "./OwnerChrome";
import { cn } from "../lib/cn";

/**
 * Everything waiting on a decision, in one window.
 *
 * The dashboard could always TELL you nine things needed review; acting on any of them meant
 * leaving the page you were on, finding the right section, and losing the list of the other eight.
 * This keeps the list in front of you and brings the queue to it instead — the same panels the
 * sections use, mounted here rather than reimplemented, so a decision made in this window goes
 * through exactly the same path as one made anywhere else.
 *
 * Opens on the most urgent item rather than an empty state, because the window is only ever opened
 * when there IS something to do, and making someone pick from a list first is a step for nothing.
 */

const SEVERITY: Record<string, StatusState> = {
  urgent: "bad",
  action: "warn",
  warn: "warn",
  info: "idle",
};

/** Which panel answers each kind of pending work. */
function panelFor(section: string) {
  switch (section) {
    case "reports":
      return <TicketQueue status="ACTIVE" />;
    case "images":
      return <OwnerImagesPanel />;
    case "videos":
      return <StaffVideosRoute />;
    case "ageReviews":
      return <OwnerAgeReviewsPanel />;
    case "duplicates":
      return <OwnerDuplicatesPanel />;
    case "bans":
      return <OwnerBansPanel />;
    case "reasons":
      return <OwnerReasonsPanel />;
    default:
      return null;
  }
}

export function OwnerReviewModal({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useAttentionItems();
  const [chosen, setChosen] = useState<string | null>(null);

  const items = data?.items ?? [];
  // Derived rather than stored, so clearing the last item of a queue moves on instead of leaving
  // the window pointed at something that no longer exists.
  const active = chosen && items.some((i) => i.kind === chosen) ? chosen : items[0]?.kind ?? null;
  const activeItem = items.find((i) => i.kind === active) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-0 sm:p-4">
      <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-none border-[var(--oc-line)] bg-[var(--oc-bg)] sm:rounded-xl sm:border">
        <header
          className="flex shrink-0 items-center gap-3 border-b border-[var(--oc-line)] px-4 py-3"
          style={{ paddingTop: "calc(0.75rem + var(--safe-top))" }}
        >
          <h2 className="font-display text-base text-signal">Needs review</h2>
          {items.length > 0 && (
            <span className="oc-num text-xs text-signal-faint">
              {items.reduce((n, i) => n + i.count, 0)} across {items.length} queue
              {items.length === 1 ? "" : "s"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close review"
            className="ml-auto text-signal-faint hover:text-signal"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-signal-faint">
            Nothing is waiting on a decision.
          </div>
        ) : (
          <>
            {/* Horizontally scrollable rather than wrapping: eight queues plus counts overflow a
                phone, and a two-line tab strip eats the panel below it. */}
            <nav className="scrollbar-none flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--oc-line)] px-3 py-2">
              {items.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => setChosen(item.kind)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors",
                    active === item.kind
                      ? "bg-accent text-white"
                      : "bg-[var(--oc-panel-raised)] text-signal-dim hover:text-signal",
                  )}
                >
                  {active !== item.kind && <StatusDot state={SEVERITY[item.severity] ?? "warn"} />}
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activeItem && panelFor(activeItem.section) ? (
                panelFor(activeItem.section)
              ) : (
                // A queue with no panel of its own — the counts that are worth seeing but have
                // nothing to decide, like this week's refused under-18 signups.
                <div className="p-6 text-sm text-signal-dim">
                  <p className="text-signal">{activeItem?.label}</p>
                  <p className="mt-1 text-xs text-signal-faint">
                    Nothing to decide here — this is a count worth knowing, not a queue.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
