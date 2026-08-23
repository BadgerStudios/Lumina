import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Check, X, EyeOff, Trash2, Fingerprint } from "lucide-react";
import { api } from "../lib/apiClient";
import type { VideoDTO } from "@lumina/shared";
import {
  useStaffVideos,
  useStaffVideoCounts,
  useApproveVideo,
  useRejectVideo,
  useRemoveVideo,
  usePurgeVideoMedia,
  type StaffQueueStatus,
} from "../queries/staff";
import { videoMediaUrl } from "../queries/videos";
import { useAuthStore } from "../store/authStore";
import { isMaster } from "../lib/platformRole";
import { UserAvatar } from "../components/common/UserAvatar";
import { cn } from "../lib/cn";

const TABS: Array<{ key: StaffQueueStatus; label: string }> = [
  { key: "PENDING_REVIEW", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "REMOVED", label: "Removed" },
  { key: "FAILED", label: "Failed" },
];

/**
 * The video queue — one section of the staff suite (see routes/staff/StaffLayout.tsx).
 *
 * The suite owns the page header, the role gate and the outer scroll container, so this renders
 * only its own status tabs and their contents. Nothing here is access control either way: every
 * /api/staff route independently enforces requireStaff server-side, so a user who edits this role
 * in their own client gets an empty page and 403s rather than anyone else's pending uploads.
 */
export function StaffVideosRoute() {
  const [tab, setTab] = useState<StaffQueueStatus>("PENDING_REVIEW");
  const { data: counts } = useStaffVideoCounts();

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-hairline bg-base-800/60 px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium transition",
              tab === t.key ? "bg-base-600 text-signal" : "text-signal-dim hover:text-signal",
            )}
          >
            {t.label}
            {counts?.[t.key] ? (
              <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-white">
                {counts[t.key]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex-1 p-4">
        <QueuePanel status={tab} />
      </div>
    </div>
  );
}

function QueuePanel({ status }: { status: StaffQueueStatus }) {
  const { data: videos, isLoading } = useStaffVideos(status);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }
  if (!videos || videos.length === 0) {
    return <p className="py-10 text-center text-signal-dim">Nothing here.</p>;
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
      {videos.map((video) => (
        <ReviewCard key={video.id} video={video} status={status} />
      ))}
    </div>
  );
}

function ReviewCard({ video, status }: { video: VideoDTO; status: StaffQueueStatus }) {
  const approve = useApproveVideo();
  const reject = useRejectVideo();
  const remove = useRemoveVideo();
  const purge = usePurgeVideoMedia();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"none" | "reject" | "remove">("none");
  const src = videoMediaUrl(video.playbackUrl);
  const busy = approve.isPending || reject.isPending || remove.isPending || purge.isPending;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-base-800">
      <div className="aspect-video bg-black">
        {src ? (
          // Staff need to actually watch the thing before deciding, so this is a full player with
          // controls rather than a poster image — and it must not autoplay, since a queue of
          // simultaneously-playing videos is unusable.
          <video src={src} controls preload="metadata" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-signal-faint">
            No playable media {video.failureReason ? `— ${video.failureReason}` : ""}
          </div>
        )}
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          <UserAvatar
            avatarUrl={video.author?.avatarUrl ?? null}
            name={video.author?.displayName ?? video.author?.username ?? "?"}
            size={28}
          />
          <div className="min-w-0">
            <p className="truncate text-sm text-signal">
              {video.author?.displayName ?? video.author?.username ?? "[deleted user]"}
            </p>
            <p className="text-xs text-signal-faint">
              {new Date(video.createdAt).toLocaleString()}
              {video.durationMs ? ` · ${Math.round(video.durationMs / 1000)}s` : ""}
            </p>
          </div>
        </div>

        {video.caption && <p className="text-sm text-signal-dim">{video.caption}</p>}
        {video.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {video.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-base-700 px-2 py-0.5 text-xs text-signal-dim">
                #{tag}
              </span>
            ))}
          </div>
        )}
        {video.rejectionReason && (
          <p className="text-sm text-flare">Reason given: {video.rejectionReason}</p>
        )}

        <ProvenanceSection videoId={video.id} />

        {mode !== "none" && (
          // A <form> rather than a bare input+button: without it, pressing Enter after typing a
          // reason — the reflexive way to submit a single-line text field — did nothing at all,
          // since only the Confirm button's own onClick ran the mutation. That silent no-op is
          // indistinguishable from "the takedown button is broken" to whoever is using it.
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason.trim() || busy) return;
              const args = { videoId: video.id, reason: reason.trim() };
              // Reset only on success, not right after firing: resetting unconditionally made a
              // failed submit look identical to a successful one — the form vanished either way.
              const onSuccess = () => { setMode("none"); setReason(""); };
              if (mode === "reject") reject.mutate(args, { onSuccess });
              else remove.mutate(args, { onSuccess });
            }}
          >
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 300))}
              placeholder={mode === "reject" ? "Why is this being rejected?" : "Why is this being removed?"}
              className="w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!reason.trim() || busy}
                className="rounded-lg bg-flare px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("none");
                  setReason("");
                }}
                className="rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal"
              >
                Cancel
              </button>
            </div>
            {/* The reason is shown verbatim to the uploader, so it should read as an explanation
                rather than an internal note. */}
            <p className="text-xs text-signal-faint">The uploader will see this reason.</p>
          </form>
        )}

        {mode === "none" && (
          <div className="flex flex-wrap gap-2">
            {(status === "PENDING_REVIEW" || status === "REMOVED") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => approve.mutate({ videoId: video.id })}
                className="flex items-center gap-1 rounded-lg bg-pulse px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
              >
                <Check className="h-4 w-4" /> Approve
              </button>
            )}
            {status === "PENDING_REVIEW" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("reject")}
                className="flex items-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
              >
                <X className="h-4 w-4" /> Reject
              </button>
            )}
            {status === "APPROVED" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("remove")}
                className="flex items-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
              >
                <EyeOff className="h-4 w-4" /> Take down
              </button>
            )}
            {(status === "REJECTED" || status === "REMOVED") && video.playbackUrl && (
              <button
                type="button"
                disabled={busy}
                onClick={() => purge.mutate({ videoId: video.id })}
                className="flex items-center gap-1 rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
                title="Delete the media files. The record and audit trail are kept."
              >
                <Trash2 className="h-4 w-4" /> Purge media
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface Provenance {
  videoId: string;
  uploadedAt: string;
  sha256: string | null;
  uploader: { id: string; username: string; displayName: string | null; email: string } | null;
  ip: string | null;
  device: string | null;
  userAgent: string | null;
  purgedAt: string | null;
}

/**
 * Upload provenance — master only, and hidden entirely below that rank.
 *
 * The data has been recorded on every upload since it was added, but nothing in any client ever
 * requested it, which made it retrievable only by hand from SQL — no use at all in the situation it
 * exists for. It stays behind an explicit click rather than rendering with the card: the server
 * writes a PROVENANCE_VIEW audit entry on every read, and a panel that fetched on mount would log
 * an access every time a moderator scrolled past a video.
 */
function ProvenanceSection({ videoId }: { videoId: string }) {
  const role = useAuthStore((s) => s.user?.platformRole);
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["provenance", videoId],
    queryFn: () => api.get<Provenance>(`/master/videos/${videoId}/provenance`),
    enabled: open,
    staleTime: Infinity,
  });

  if (!isMaster(role)) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs text-signal-faint hover:text-signal"
      >
        <Fingerprint className="h-3.5 w-3.5" />
        Show upload provenance
      </button>
    );
  }

  return (
    <div className="space-y-1 rounded-lg border border-hairline bg-base-900 p-2 text-xs">
      <div className="flex items-center gap-1.5 text-signal-dim">
        <Fingerprint className="h-3.5 w-3.5" />
        Upload provenance
        <span className="ml-auto text-signal-faint">this view is logged</span>
      </div>
      {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-signal-faint" />}
      {error && <p className="text-flare">{(error as Error).message}</p>}
      {data && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-signal-dim">
          <ProvenanceRow label="Uploader">
            {data.uploader ? `${data.uploader.username} · ${data.uploader.email}` : "[deleted user]"}
          </ProvenanceRow>
          <ProvenanceRow label="Uploaded">{new Date(data.uploadedAt).toLocaleString()}</ProvenanceRow>
          <ProvenanceRow label="IP">{data.ip ?? "—"}</ProvenanceRow>
          <ProvenanceRow label="Device">{data.device ?? "—"}</ProvenanceRow>
          <ProvenanceRow label="User agent">{data.userAgent ?? "—"}</ProvenanceRow>
          {/* Identifies the file independently of any account, which is what a takedown or a
              law-enforcement reference actually needs. */}
          <ProvenanceRow label="SHA-256">
            <span className="break-all font-mono">{data.sha256 ?? "—"}</span>
          </ProvenanceRow>
          {data.purgedAt && (
            <ProvenanceRow label="Purged">{new Date(data.purgedAt).toLocaleString()}</ProvenanceRow>
          )}
        </dl>
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-signal-faint hover:text-signal"
      >
        Hide
      </button>
    </div>
  );
}

function ProvenanceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-signal-faint">{label}</dt>
      <dd className="min-w-0 text-signal">{children}</dd>
    </>
  );
}
