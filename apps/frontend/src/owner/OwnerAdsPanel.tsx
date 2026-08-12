import { AlertTriangle } from "lucide-react";
import { useAdReviewQueue, useAdRevenue } from "../queries/ads";
import { AdReviewQueue } from "../components/staff/AdReviewQueue";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Ad review and accrual reporting.
 *
 * Every campaign passes a human before it delivers, for the same reason every video does: the
 * creative ends up in the public feed either way, so splitting it across two review surfaces with
 * two standards would be the only difference.
 */
export function OwnerAdsPanel() {
  // Still queried here, but only for the 'awaiting review' count in the header tiles.
  const queue = useAdReviewQueue();
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
        {/* The same component the staff suite renders, not a copy of it. Ad review is staff work
            that an owner can also do (the ladder is >=); duplicating the queue here would have been
            two implementations of one decision, drifting apart, writing to one audit trail. */}
        <AdReviewQueue />
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
