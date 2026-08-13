import { useEffect, useRef, useState } from "react";
import { GiftSheet } from "./GiftSheet";
import { useAuthStore } from "../../store/authStore";
import {
  Gift as GiftIcon,
  Heart,
  MessageCircle,
  Volume2,
  VolumeX,
  Play,
  Flag,
  Shuffle,
} from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import { videoMediaUrl, recordView, useToggleLike } from "../../queries/videos";
import { recordAdImpression, recordAdClick } from "../../queries/ads";
import { useFeedStore } from "../../store/feedStore";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";
import { FeedText } from "./FeedText";

interface VideoCardProps {
  video: VideoDTO;
  /** Whether this card is the one currently scrolled into view. Exactly one card in the feed
   * should ever have this true — it is what drives play/pause. */
  active: boolean;
  onOpenComments?: (video: VideoDTO) => void;
  onReport?: (video: VideoDTO) => void;
  /** Omitted where there's nowhere to navigate to — the chips then render as plain labels. */
  onSelectTag?: (tag: string) => void;
  /** Opens the stitch/duet recorder. Omitted where remixing isn't offered (e.g. a staff preview),
   * which removes the button rather than showing a dead one. */
  onRemix?: (video: VideoDTO) => void;
}

/**
 * One full-viewport feed card.
 *
 * Playback is driven entirely by the `active` prop (set by the parent's IntersectionObserver), not
 * by user interaction: without a single-active-video rule every card in the DOM autoplays at once,
 * which is both an audio pile-up and enough concurrent network fetches to stall the feed.
 */
export function VideoCard({
  video,
  active,
  onOpenComments,
  onReport,
  onSelectTag,
  onRemix,
}: VideoCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const muted = useFeedStore((s) => s.muted);
  const toggleMuted = useFeedStore((s) => s.toggleMuted);
  const toggleLike = useToggleLike();
  const [stalled, setStalled] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const viewerId = useAuthStore((st) => st.user?.id);
  const [needsTap, setNeedsTap] = useState(false);
  const viewCounted = useRef(false);

  const src = videoMediaUrl(video.playbackUrl);
  const poster = videoMediaUrl(video.thumbnailUrl) ?? undefined;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (active) {
      // play() rejects when the browser blocks autoplay. That is expected rather than
      // exceptional — every mobile browser blocks autoplay with sound, and some block it entirely
      // until the user has interacted with the page. Surfacing a tap-to-play affordance is the
      // only correct response; swallowing the rejection leaves a permanently frozen frame.
      const attempt = el.play();
      if (attempt) {
        attempt.then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
      }
      if (!viewCounted.current) {
        viewCounted.current = true;
        recordView(video.id);
        // Billed only once the card actually became the active one — on screen and playing, not
        // merely rendered somewhere in the list. An impression counted on render would charge
        // advertisers for cards nobody ever saw.
        if (video.sponsoredBy) recordAdImpression(video.sponsoredBy);
      }
    } else {
      el.pause();
      // Rewind on scroll-away so returning to a card restarts it rather than resuming from a
      // half-watched position the user has no context for.
      el.currentTime = 0;
    }
  }, [active, video.id]);

  const handleLike = () => {
    toggleLike.mutate({ videoId: video.id, liked: Boolean(video.likedByMe) });
  };

  return (
    <div className="flex h-full w-full snap-start items-center justify-center overflow-hidden bg-base-900 md:p-4">
      {/* Short-form video is portrait. Letting it span a wide desktop pane leaves the frame
          marooned in black with the action rail stranded at the far edge, so the whole card is
          capped to a portrait column (9:16 of the available height) and centred. On phones the
          viewport is already narrower than that cap, so this is a no-op there.
          On desktop it becomes a real card — rounded, ringed, sitting on the app background —
          because a bare portrait strip of black against more black just looks like a broken
          render. Below md it stays edge-to-edge, which is what a phone should do. */}
      <div
        className="relative h-full w-full overflow-hidden bg-black md:rounded-2xl md:shadow-lg md:ring-1 md:ring-hairline"
        style={{ maxWidth: "min(100%, calc((100vh - 6rem) * 9 / 16))" }}
      >
        {src ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster}
            className="h-full w-full object-contain"
            loop
            playsInline
            muted={muted}
            // metadata only: the browser fetches enough to know duration/dimensions without pulling
            // whole videos for cards the user may never reach.
            preload="metadata"
            onWaiting={() => setStalled(true)}
            onPlaying={() => {
              setStalled(false);
              setNeedsTap(false);
            }}
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              if (el.paused) void el.play().catch(() => setNeedsTap(true));
              else el.pause();
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-signal-faint">
            Video unavailable
          </div>
        )}

        {(stalled || needsTap) && (
          <button
            type="button"
            onClick={() => {
              // A real user gesture satisfies the autoplay policy, so this retry is what actually
              // gets blocked playback started.
              void videoRef.current
                ?.play()
                .then(() => setNeedsTap(false))
                .catch(() => undefined);
            }}
            className="absolute inset-0 flex items-center justify-center bg-black/30"
            aria-label="Play video"
          >
            <span className="rounded-full bg-black/60 p-5">
              <Play className="h-8 w-8 text-white" fill="white" />
            </span>
          </button>
        )}

        {/* Caption + author, bottom-left, over a gradient so light video doesn't wash out the text. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 pb-6">
          {/* Disclosure sits above the author, before the caption, and is never conditional on
              anything the advertiser controls. */}
          {video.sponsoredBy && (
            <div className="pointer-events-auto mb-2 inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
              Sponsored
            </div>
          )}
          <div
            className="pointer-events-auto flex items-center gap-2"
            onClick={() => {
              if (video.sponsoredBy) recordAdClick(video.sponsoredBy);
            }}
          >
            <UserAvatar
              avatarUrl={video.author?.avatarUrl ?? null}
              name={video.author?.displayName ?? video.author?.username ?? "?"}
              size={32}
            />
            <span className="font-medium text-white drop-shadow">
              {video.author?.displayName ??
                video.author?.username ??
                "[deleted user]"}
            </span>
          </div>
          {/* Attribution for a remix. Above the caption, not inside it: the credit is a property of
              the video, and a caption is text its author chose — so a caption-based credit is one
              the author can simply leave out. */}
          {video.sourceVideo && (
            <div className="pointer-events-auto mt-2 flex items-center gap-1.5 text-xs text-white/85 drop-shadow">
              <Shuffle className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {video.derivativeType === "DUET" ? "Duet with" : "Stitch with"}{" "}
                <span className="font-semibold">
                  @{video.sourceVideo.author?.username ?? "[deleted user]"}
                </span>
              </span>
            </div>
          )}
          {video.caption && (
            // pointer-events-auto for the same reason the tag chips below need it: the caption
            // block sits inside a pointer-events-none gradient overlay, so anything clickable in
            // it has to opt back in or the hashtags are decoration.
            <p className="pointer-events-auto mt-2 max-w-[80%] text-sm text-white/90 drop-shadow">
              <FeedText text={video.caption} onSelectTag={onSelectTag} />
            </p>
          )}
          {video.tags.length > 0 && (
            // The gradient wrapper is pointer-events-none so taps fall through to the video's
            // play/pause handler; anything interactive inside it has to opt back in explicitly.
            <div className="pointer-events-auto mt-2 flex max-w-[80%] flex-wrap gap-1.5">
              {video.tags.map((tag) =>
                onSelectTag ? (
                  <button
                    key={tag}
                    type="button"
                    // Stops the card's own tap handler (play/pause) from also firing.
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTag(tag);
                    }}
                    className="rounded-full bg-white/15 px-2 py-0.5 text-xs text-white backdrop-blur-sm hover:bg-white/25"
                  >
                    #{tag}
                  </button>
                ) : (
                  <span
                    key={tag}
                    className="rounded-full bg-white/15 px-2 py-0.5 text-xs text-white backdrop-blur-sm"
                  >
                    #{tag}
                  </span>
                ),
              )}
            </div>
          )}
        </div>

        {giftOpen && video.author && (
          <GiftSheet
            creatorId={video.author.id}
            creatorName={video.author.displayName ?? video.author.username}
            contentRef={`video:${video.id}`}
            onClose={() => setGiftOpen(false)}
          />
        )}

        {/* Action rail, bottom-right — the standard short-video layout. */}
        <div className="absolute bottom-24 right-2 flex flex-col items-center gap-3">
          <ActionButton
            icon={
              <Heart
                className={cn(
                  "h-7 w-7",
                  video.likedByMe ? "text-flare" : "text-white",
                )}
                fill={video.likedByMe ? "currentColor" : "none"}
              />
            }
            label={formatCount(video.likeCount)}
            onClick={handleLike}
            ariaLabel={video.likedByMe ? "Unlike" : "Like"}
          />
          <ActionButton
            icon={<MessageCircle className="h-7 w-7 text-white" />}
            label={formatCount(video.commentCount)}
            onClick={() => onOpenComments?.(video)}
            ariaLabel="Comments"
          />
          <ActionButton
            icon={
              muted ? (
                <VolumeX className="h-7 w-7 text-white" />
              ) : (
                <Volume2 className="h-7 w-7 text-white" />
              )
            }
            label=""
            onClick={toggleMuted}
            ariaLabel={muted ? "Unmute" : "Mute"}
          />
          {video.author && video.author.id !== viewerId && (
            <ActionButton
              icon={<GiftIcon className="h-7 w-7 text-white" />}
              label=""
              onClick={() => setGiftOpen(true)}
              ariaLabel="Send a gift"
            />
          )}
          {onRemix && (video.allowStitch || video.allowDuet) && (
            <ActionButton
              icon={<Shuffle className="h-7 w-7 text-white" />}
              label={video.derivativeCount > 0 ? formatCount(video.derivativeCount) : ""}
              onClick={() => onRemix(video)}
              ariaLabel="Stitch or duet this video"
            />
          )}
          <ActionButton
            icon={<Flag className="h-6 w-6 text-white/80" />}
            label=""
            onClick={() => onReport?.(video)}
            ariaLabel="Report this video"
          />
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="group/action flex flex-col items-center gap-1"
    >
      {/* A translucent disc behind each icon rather than a drop-shadow alone. White glyphs over
          arbitrary user video are unreadable the moment the frame behind them is bright — a
          shadow doesn't rescue white-on-white, and the like count under the heart disappeared
          entirely against a light background. The disc guarantees contrast on any frame. */}
      <span className="rounded-full bg-black/40 p-2 backdrop-blur-sm transition group-hover/action:bg-black/60">
        {icon}
      </span>
      {label && (
        <span className="rounded-full bg-black/40 px-1.5 text-xs font-medium text-white backdrop-blur-sm">
          {label}
        </span>
      )}
    </button>
  );
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
