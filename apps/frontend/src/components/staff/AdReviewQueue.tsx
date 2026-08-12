import { Megaphone, Check, X, Loader2 } from "lucide-react";
import { useAdReviewQueue, useReviewCampaign } from "../../queries/ads";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The ad review queue, as a component rather than a section of one page.
 *
 * It used to live inside OwnerAdsPanel and nowhere else — which meant that although `/api/ads/review`
 * is gated on `requireStaff`, the only way to reach it was through the owner console, which staff
 * cannot open. Staff had the permission and no door. Extracting it lets the staff suite and the
 * owner console render the same queue rather than growing a second one with its own quirks.
 *
 * Note what did NOT move: revenue. What a campaign earns is the platform's business, not a
 * moderator's, and the owner console keeps it.
 */
export function AdReviewQueue() {
  const queue = useAdReviewQueue();
  const review = useReviewCampaign();

  if (queue.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      </div>
    );
  }

  if ((queue.data ?? []).length === 0) {
    return (
      <p className="rounded-lg border border-hairline bg-base-800 p-4 text-sm text-signal-dim">
        Nothing waiting.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {queue.data!.map((c) => (
        <div key={c.id} className="flex items-start gap-3 rounded-lg border border-hairline bg-base-800 p-3">
          {c.video?.thumbnailUrl && (
            <img src={c.video.thumbnailUrl} alt="" className="h-16 w-10 shrink-0 rounded object-cover" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <Megaphone className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate font-medium text-signal">{c.name}</span>
            </div>
            <p className="mt-0.5 text-xs text-signal-dim">
              @{c.advertiser?.username ?? "unknown"} · {money(c.cpmCents)} CPM ·{" "}
              {money(c.totalBudgetCents)} budget
            </p>
            {c.video?.caption && (
              <p className="mt-1 line-clamp-2 text-xs text-signal-faint">{c.video.caption}</p>
            )}
            {/* Approving does not start the campaign — it only clears the creative. The advertiser
                still has to pay before anything delivers, and saying so here stops a reviewer
                reading an approval as "this is now live". */}
            <p className="mt-1 text-[11px] text-signal-faint">
              Approving clears the creative; the advertiser still has to pay {money(c.totalBudgetCents)}{" "}
              before it runs.
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => review.mutate({ id: c.id, approve: true })}
              disabled={review.isPending}
              aria-label={`Approve ${c.name}`}
              className="rounded bg-online/15 p-1.5 text-online hover:bg-online/25 disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                // A rejection without a reason is one the advertiser can't act on, so the server
                // requires one and so does this.
                const reason = window.prompt("Why is this being rejected?");
                if (reason?.trim()) review.mutate({ id: c.id, approve: false, reason: reason.trim() });
              }}
              disabled={review.isPending}
              aria-label={`Reject ${c.name}`}
              className="rounded bg-dnd/15 p-1.5 text-dnd hover:bg-dnd/25 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
