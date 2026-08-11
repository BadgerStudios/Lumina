import { Loader2, Clock, CheckCircle2, XCircle, AlertTriangle, EyeOff } from "lucide-react";
import type { VideoDTO, VideoStatus } from "@lumina/shared";
import { useMyVideos, videoMediaUrl, useUpdateRemixSettings } from "../../queries/videos";

/**
 * The uploader's own videos with their real moderation status.
 *
 * This is the counterpart to review-gating: without somewhere to see "awaiting review" or "rejected,
 * here's why", an upload simply disappears after the success toast and the user has no way to tell
 * whether the app broke or a human declined it.
 */
export function MyVideosPanel() {
  const { data: videos, isLoading } = useMyVideos();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
      </div>
    );
  }

  if (!videos || videos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-signal-dim">
        You haven't uploaded any videos yet.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-base-900 p-4">
      <div className="mx-auto grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-3">
        {videos.map((video) => (
          <MyVideoTile key={video.id} video={video} />
        ))}
      </div>
    </div>
  );
}

const STATUS_META: Record<
  VideoStatus,
  { label: string; icon: React.ReactNode; className: string; hint?: string }
> = {
  PROCESSING: {
    label: "Processing",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    className: "text-signal-dim",
    hint: "Converting your video so it plays everywhere.",
  },
  PENDING_REVIEW: {
    label: "Awaiting review",
    icon: <Clock className="h-3.5 w-3.5" />,
    className: "text-amber",
    hint: "A moderator will review this before it appears in the feed.",
  },
  APPROVED: {
    label: "Live",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    className: "text-pulse",
  },
  REJECTED: {
    label: "Rejected",
    icon: <XCircle className="h-3.5 w-3.5" />,
    className: "text-flare",
  },
  REMOVED: {
    label: "Removed",
    icon: <EyeOff className="h-3.5 w-3.5" />,
    className: "text-flare",
  },
  FAILED: {
    label: "Failed",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    className: "text-flare",
  },
};

function MyVideoTile({ video }: { video: VideoDTO }) {
  const updateRemix = useUpdateRemixSettings();
  const status = video.status ?? "PROCESSING";
  const meta = STATUS_META[status];
  const thumb = videoMediaUrl(video.thumbnailUrl);
  // Rejection and transcode failure are different things with different fixes, so they get
  // different explanations rather than one generic "something went wrong".
  const reason = video.rejectionReason ?? video.failureReason ?? meta.hint;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-base-800">
      <div className="relative aspect-[9/16] bg-black">
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-signal-faint">
            No preview
          </div>
        )}
      </div>
      <div className="space-y-1 p-2">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${meta.className}`}>
          {meta.icon}
          {meta.label}
        </div>
        {video.caption && <p className="line-clamp-2 text-xs text-signal-dim">{video.caption}</p>}
        {reason && <p className="text-xs text-signal-faint">{reason}</p>}
        {status === "APPROVED" && (
          <p className="text-xs text-signal-faint">
            {video.likeCount} likes · {video.viewCount} views
            {video.derivativeCount > 0 && ` · ${video.derivativeCount} remixes`}
          </p>
        )}
        {/* Only once a video is actually public: before then there is nothing for anyone to remix,
            and a control that has no effect yet is just a thing to second-guess. */}
        {status === "APPROVED" && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <RemixChip
              label="Duets"
              on={video.allowDuet}
              busy={updateRemix.isPending}
              onToggle={() => updateRemix.mutate({ videoId: video.id, allowDuet: !video.allowDuet })}
            />
            <RemixChip
              label="Stitches"
              on={video.allowStitch}
              busy={updateRemix.isPending}
              onToggle={() => updateRemix.mutate({ videoId: video.id, allowStitch: !video.allowStitch })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RemixChip({
  label,
  on,
  busy,
  onToggle,
}: {
  label: string;
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={on}
      // The state is spelled out rather than left to colour alone: "Duets on" / "Duets off" is
      // legible to a screen reader and to anyone who can't tell the two chip colours apart.
      className={
        "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 transition disabled:opacity-50 " +
        (on
          ? "bg-accent/15 text-accent ring-accent/40 hover:bg-accent/25"
          : "bg-base-700 text-signal-faint ring-base-600 hover:text-signal")
      }
    >
      {label} {on ? "on" : "off"}
    </button>
  );
}
