import { useState } from "react";
import { Megaphone, Loader2, AlertTriangle, Pause, Play } from "lucide-react";
import { useMyCampaigns, useCreateCampaign, useSetCampaignPaused, type AdCampaign } from "../../queries/ads";
import { useMyVideos } from "../../queries/videos";

/**
 * The self-serve advertiser console, in user settings.
 *
 * You promote a video you have already uploaded and that a moderator has already approved — so ad
 * creative goes through the same review as everything else in the feed, and a sponsored card is
 * the same component as an organic one rather than a separate widget people learn to skip.
 */

const MIN_CPM_CENTS = 100;
const MIN_BUDGET_CENTS = 500;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const STATUS_TONE: Record<string, string> = {
  APPROVED: "text-online",
  PENDING_REVIEW: "text-amber",
  REJECTED: "text-dnd",
  PAUSED: "text-signal-dim",
  COMPLETED: "text-signal-faint",
  DRAFT: "text-signal-faint",
};

export function AdvertisingSection() {
  const campaigns = useMyCampaigns();
  const myVideos = useMyVideos();
  const create = useCreateCampaign();
  const [open, setOpen] = useState(false);

  // Only approved videos can be promoted. Showing the rest in the picker and rejecting on submit
  // would be a worse way to say the same thing.
  const promotable = (myVideos.data ?? []).filter((v) => v.status === "APPROVED");

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-hairline bg-base-900 p-3 text-sm text-signal-dim">
        <p className="flex items-start gap-2">
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            Promote one of your approved videos in the For You feed. Ads appear as normal cards with
            a <span className="font-semibold text-signal">Sponsored</span> label, at fixed intervals —
            buying more never makes the feed denser, it just queues.
          </span>
        </p>
      </div>

      {/* Said up front rather than discovered at the end. Delivery works; collection doesn't yet. */}
      <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Payment collection isn't switched on for this instance yet. Campaigns run and their spend
          is tracked, but nothing is charged.
        </span>
      </div>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={promotable.length === 0}
          className="self-start rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          New campaign
        </button>
      ) : (
        <CampaignForm
          videos={promotable}
          pending={create.isPending}
          onCancel={() => setOpen(false)}
          onSubmit={(body) => create.mutate(body, { onSuccess: () => setOpen(false) })}
        />
      )}

      {promotable.length === 0 && (
        <p className="text-xs text-signal-faint">
          You need at least one approved video before you can advertise. Upload one from the feed and
          wait for it to be reviewed.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {campaigns.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : (campaigns.data ?? []).length === 0 ? (
          <p className="text-sm text-signal-dim">No campaigns yet.</p>
        ) : (
          campaigns.data!.map((c) => <CampaignRow key={c.id} campaign={c} />)
        )}
      </div>
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: AdCampaign }) {
  const setPaused = useSetCampaignPaused();
  const canPause = campaign.status === "APPROVED" || campaign.status === "PAUSED";
  // Delivery is a proportion of budget, which is the number an advertiser actually cares about —
  // impressions alone don't say how much is left.
  const progress = campaign.totalBudgetCents > 0 ? (campaign.spentCents / campaign.totalBudgetCents) * 100 : 0;

  return (
    <div className="rounded-lg border border-hairline bg-base-900 p-3">
      <div className="flex items-start gap-3">
        {campaign.video?.thumbnailUrl && (
          <img src={campaign.video.thumbnailUrl} alt="" className="h-14 w-9 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-signal">{campaign.name}</span>
            <span className={`shrink-0 text-xs font-medium ${STATUS_TONE[campaign.status] ?? "text-signal-dim"}`}>
              {campaign.status.replace("_", " ").toLowerCase()}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-signal-dim">
            {money(campaign.cpmCents)} CPM · {money(campaign.spentCents)} of {money(campaign.totalBudgetCents)} spent ·{" "}
            {campaign.impressionCount.toLocaleString()} impressions · {campaign.clickCount.toLocaleString()} clicks
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-base-700">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
          {campaign.rejectionReason && (
            <p className="mt-1.5 text-xs text-dnd">Rejected: {campaign.rejectionReason}</p>
          )}
        </div>
        {canPause && (
          <button
            type="button"
            onClick={() => setPaused.mutate({ id: campaign.id, paused: campaign.status === "APPROVED" })}
            disabled={setPaused.isPending}
            aria-label={campaign.status === "APPROVED" ? "Pause campaign" : "Resume campaign"}
            className="shrink-0 rounded p-1.5 text-signal-faint hover:text-signal disabled:opacity-50"
          >
            {campaign.status === "APPROVED" ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function CampaignForm({
  videos,
  pending,
  onCancel,
  onSubmit,
}: {
  videos: Array<{ id: string; caption: string | null }>;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    name: string;
    videoId: string;
    cpmCents: number;
    totalBudgetCents: number;
    startsAt: string;
    endsAt: string;
  }) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState("");
  const [videoId, setVideoId] = useState(videos[0]?.id ?? "");
  const [cpm, setCpm] = useState("2.00");
  const [budget, setBudget] = useState("25.00");
  const [starts, setStarts] = useState(today);
  const [ends, setEnds] = useState(today);

  const cpmCents = Math.round(Number(cpm) * 100);
  const budgetCents = Math.round(Number(budget) * 100);
  const valid =
    name.trim() && videoId && cpmCents >= MIN_CPM_CENTS && budgetCents >= MIN_BUDGET_CENTS && ends >= starts;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-base-900 p-3">
      <Field label="Campaign name">
        <input
          aria-label="Campaign name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        />
      </Field>

      <Field label="Video to promote">
        <select
          aria-label="Video to promote"
          value={videoId}
          onChange={(e) => setVideoId(e.target.value)}
          className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
        >
          {videos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.caption?.slice(0, 60) || `Video ${v.id}`}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={`CPM (min $${(MIN_CPM_CENTS / 100).toFixed(2)})`}>
          <input
            aria-label="Cost per thousand impressions"
            type="number"
            step="0.01"
            min={MIN_CPM_CENTS / 100}
            value={cpm}
            onChange={(e) => setCpm(e.target.value)}
            className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label={`Total budget (min $${(MIN_BUDGET_CENTS / 100).toFixed(2)})`}>
          <input
            aria-label="Total budget"
            type="number"
            step="0.01"
            min={MIN_BUDGET_CENTS / 100}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <input
            aria-label="Campaign start date"
            type="date"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
            className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Ends">
          <input
            aria-label="Campaign end date"
            type="date"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
            className="w-full rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
        </Field>
      </div>

      <p className="text-xs text-signal-faint">
        At {money(cpmCents || 0)} CPM, {money(budgetCents || 0)} buys about{" "}
        {cpmCents > 0 ? Math.round((budgetCents / cpmCents) * 1000).toLocaleString() : 0} impressions.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              videoId,
              cpmCents,
              totalBudgetCents: budgetCents,
              // Ends at the close of the chosen day, not its midnight start — otherwise a
              // single-day campaign would have a zero-length window and never deliver.
              startsAt: new Date(`${starts}T00:00:00Z`).toISOString(),
              endsAt: new Date(`${ends}T23:59:59Z`).toISOString(),
            })
          }
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Submit for review
        </button>
        <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-sm text-signal-dim hover:bg-base-700">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-bold uppercase text-signal-dim">{label}</span>
      {children}
    </label>
  );
}
