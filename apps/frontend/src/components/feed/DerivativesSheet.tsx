import { useState } from "react";
import { X, Loader2, Play } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import { useVideoDerivatives, videoMediaUrl } from "../../queries/videos";
import { useFeedStore } from "../../store/feedStore";
import { UserAvatar } from "../common/UserAvatar";

/**
 * "View remixes" — everything stitched/duetted from a video, opened from the remix count on its
 * card. Mirrors CommentSheet's layout (same sizing, same header/close pattern) since this is the
 * same kind of thing: a bottom sheet over the feed listing records that belong to one video.
 */
export function DerivativesSheet({
  video,
  onClose,
}: {
  video: VideoDTO | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useVideoDerivatives(video?.id ?? null);
  // Which tile (if any) is playing inline. Cleared implicitly whenever the sheet re-opens for a
  // different video, since this component is only ever mounted once by FeedRoute.
  const [playingId, setPlayingId] = useState<string | null>(null);
  const muted = useFeedStore((s) => s.muted);

  if (!video) return null;

  const derivatives = data?.videos ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="flex h-[calc(var(--app-height-safe)*0.70)] w-full max-w-md flex-col rounded-t-xl border border-hairline bg-base-800 sm:h-[calc(var(--app-height-safe)*0.80)] sm:rounded-xl">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="font-display text-signal">
            Remixes{video.derivativeCount > 0 ? ` (${video.derivativeCount})` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close remixes"
            className="text-signal-faint hover:text-signal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
            </div>
          ) : derivatives.length === 0 ? (
            <p className="py-8 text-center text-sm text-signal-dim">
              Nothing's been made from this video yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {derivatives.map((d) => (
                <DerivativeTile
                  key={d.id}
                  video={d}
                  playing={playingId === d.id}
                  muted={muted}
                  onTap={() => setPlayingId((cur) => (cur === d.id ? null : d.id))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One derivative — plays inline, muted by the same global toggle as the main feed, the same way a
 * card in the feed itself plays: no navigation to a separate page, just the video starting where
 * you already are.
 */
function DerivativeTile({
  video,
  playing,
  muted,
  onTap,
}: {
  video: VideoDTO;
  playing: boolean;
  muted: boolean;
  onTap: () => void;
}) {
  const src = videoMediaUrl(video.playbackUrl);
  const poster = videoMediaUrl(video.thumbnailUrl) ?? undefined;

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={playing ? "Pause" : "Play"}
      className="group relative block aspect-[9/16] overflow-hidden rounded-lg bg-black text-left"
    >
      {playing && src ? (
        <video
          src={src}
          poster={poster}
          className="h-full w-full object-cover"
          autoPlay
          loop
          playsInline
          muted={muted}
        />
      ) : poster ? (
        <img src={poster} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-signal-faint">
          No preview
        </div>
      )}

      {!playing && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 transition group-hover:bg-black/30">
          <span className="rounded-full bg-black/60 p-2">
            <Play className="h-4 w-4 text-white" fill="white" />
          </span>
        </span>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent p-1.5">
        <UserAvatar
          avatarUrl={video.author?.avatarUrl ?? null}
          name={video.author?.displayName ?? video.author?.username ?? "?"}
          size={18}
        />
        <span className="truncate text-[11px] font-medium text-white drop-shadow">
          {video.author?.displayName ?? video.author?.username ?? "[deleted user]"}
        </span>
      </div>
    </button>
  );
}
