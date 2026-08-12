import { Megaphone, Check, X, Loader2, AlertTriangle } from "lucide-react";
import { useAdReviewQueue, useReviewCampaign, useAdRevenue } from "../queries/ads";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Ad review and accrual reporting.
 *
 * Every campaign passes a human before it delivers, for the same reason every video does: the
 * creative ends up in the public feed either way, so splitting it across two review surfaces with
 * two standards would be the only difference.
 */
export function OwnerAdsPanel() {
  const queue = useAdReviewQueue();
  const review = useReviewCampaign();
  const revenue = useAdRevenue();

  return (
    <div className="flex flex-col gap-5">
      {/* Collected first, because it is the real number. Accrued sits beside it rather than
          replacing it: campaigns are prepaid, so the two differ by whatever has been paid for but
          not yet delivered — inventory still owed, not profit. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Collected" value={money(revenue.data?.collectedCents ?? 0)} />
        <Stat label="Earned by delivery" value={money(revenue.data?.accruedCents ?? 0)} />
        <Stat label="Impressions" value={(revenue.data?.impressions ?? 0).toLocaleString()} />
        <Stat
          label="Awaiting review"
          value={String(queue.data?.length ?? 0)}
          warn={(queue.data?.length ?? 0) > 0}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Clicks" value={(revenue.data?.clicks ?? 0).toLocaleString()} />
        <Stat label="Owed as inventory" value={money(revenue.data?.unearnedCents ?? 0)} />
        <Stat label="Paid campaigns" value={String(revenue.data?.fundedCampaigns ?? 0)} />
        {/* Approved but never paid for. A number that climbs here means checkout is failing, and
            it would otherwise be invisible — the campaigns simply never run. */}
        <Stat
          label="Approved, unpaid"
          value={String(revenue.data?.awaitingPaymentCampaigns ?? 0)}
          warn={(revenue.data?.awaitingPaymentCampaigns ?? 0) > 0}
        />
      </div>

      {revenue.data && !revenue.data.collected && (
        <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            These figures are <strong>accrued</strong>, not collected — this server has no payment
            processor connected, so no advertiser can be charged.
          </span>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-bold uppercase text-signal-dim">Awaiting review</h3>
        {queue.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : (queue.data ?? []).length === 0 ? (
          <p className="rounded-lg border border-hairline bg-base-800 p-3 text-sm text-signal-dim">
            Nothing waiting.
          </p>
        ) : (
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
                      // A rejection without a reason is one the advertiser can't act on, so the
                      // server requires one and so does this.
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
        )}
      </div>

      {(revenue.data?.days.length ?? 0) > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-bold uppercase text-signal-dim">Last 30 days</h3>
          <div className="overflow-x-auto rounded-lg border border-hairline bg-base-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs uppercase text-signal-dim">
                  <th className="px-3 py-2">Day</th>
                  <th className="px-3 py-2">Impressions</th>
                  <th className="px-3 py-2">Clicks</th>
                  <th className="px-3 py-2">Accrued</th>
                </tr>
              </thead>
              <tbody>
                {revenue.data!.days.map((d) => (
                  <tr key={d.day} className="border-b border-hairline/40 last:border-0">
                    <td className="px-3 py-1.5 text-signal-dim">{d.day}</td>
                    <td className="px-3 py-1.5 text-signal">{d.impressions.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-signal">{d.clicks.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-signal">{money(d.accruedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border bg-base-800 p-3 ${warn ? "border-amber/50" : "border-hairline"}`}>
      <div className="text-xs font-bold uppercase text-signal-dim">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-amber" : "text-signal"}`}>{value}</div>
    </div>
  );
}
