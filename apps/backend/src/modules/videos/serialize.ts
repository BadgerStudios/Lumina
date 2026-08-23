import type { VideoDTO } from "@lumina/shared";
import { serializeUser } from "../../lib/serialize.js";

type VideoAuthor = Parameters<typeof serializeUser>[0];

export type VideoLike = {
  id: bigint;
  caption: string | null;
  status: string;
  playbackKey: string | null;
  thumbnailKey: string | null;
  progressPct: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  likeCount: number;
  viewCount: number;
  commentCount: number;
  rejectionReason: string | null;
  failureReason: string | null;
  createdAt: Date;
  author: VideoAuthor | null;
  /** Optional so callers that don't `include` the relation still typecheck; they serialize as []. */
  tags?: Array<{ tag: { name: string } }>;
  allowStitch: boolean;
  allowDuet: boolean;
  derivativeType: string | null;
  derivativeCount: number;
  /** Optional for the same reason as `tags` — a query that doesn't include the relation still
   * typechecks and serializes the attribution as null. */
  sourceVideo?: {
    id: bigint;
    caption: string | null;
    thumbnailKey: string | null;
    author: VideoAuthor | null;
  } | null;
};

function baseFields(video: VideoLike) {
  return {
    id: video.id.toString(),
    author: video.author ? serializeUser(video.author) : null,
    caption: video.caption,
    // Keys are internal on-disk filenames and never leave the backend — the client only ever gets
    // an id-addressed route that re-authorizes per request. Null while PROCESSING/FAILED, which is
    // what lets the client distinguish "not ready yet" from "ready to play".
    playbackUrl: video.playbackKey ? `/api/videos/${video.id}/playback` : null,
    thumbnailUrl: video.thumbnailKey ? `/api/videos/${video.id}/thumbnail` : null,
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    likeCount: video.likeCount,
    viewCount: video.viewCount,
    commentCount: video.commentCount,
    tags: video.tags?.map((t) => t.tag.name) ?? [],
    createdAt: video.createdAt.toISOString(),
    allowStitch: video.allowStitch,
    allowDuet: video.allowDuet,
    derivativeType: (video.derivativeType as "STITCH" | "DUET" | null) ?? null,
    derivativeCount: video.derivativeCount,
    sourceVideo: video.sourceVideo
      ? {
          id: video.sourceVideo.id.toString(),
          author: video.sourceVideo.author ? serializeUser(video.sourceVideo.author) : null,
          caption: video.sourceVideo.caption,
          thumbnailUrl: video.sourceVideo.thumbnailKey
            ? `/api/videos/${video.sourceVideo.id}/thumbnail`
            : null,
        }
      : null,
  };
}

/**
 * PUBLIC feed form — moderation state is omitted entirely, not merely nulled. Callers must only
 * pass APPROVED videos; this deliberately has no status field to leak one through.
 */
export function serializeVideo(video: VideoLike, likedByMe: boolean): VideoDTO {
  return { ...baseFields(video), likedByMe };
}

/**
 * OWNER/STAFF form — includes status and the reason fields, so an uploader can see that their
 * video is awaiting review, was rejected (and why), or failed to transcode. Without this an upload
 * would simply vanish with no explanation, which is the worst failure mode of a review-gated feed.
 * Never returned from a feed route.
 */
export function serializeVideoWithStatus(video: VideoLike, likedByMe?: boolean): VideoDTO {
  return {
    ...baseFields(video),
    ...(likedByMe === undefined ? {} : { likedByMe }),
    status: video.status as VideoDTO["status"],
    rejectionReason: video.rejectionReason,
    failureReason: video.failureReason,
    // Only meaningful while status is PROCESSING; harmless (and unused) otherwise. Owner/staff
    // form only, same reasoning as status itself — the public feed never shows a PROCESSING video.
    progressPct: video.progressPct,
  };
}

/**
 * Spread into any `include` whose result is handed to a serializer. Kept next to the serializer that
 * consumes it so a new video query can't quietly return `tags: []` for a video that has tags — the
 * relation being optional on `VideoLike` makes that failure silent rather than a type error.
 */
export const VIDEO_TAGS_INCLUDE = {
  tags: { include: { tag: { select: { name: true } } } },
} as const;


export const VIDEO_AUTHOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  statusText: true,
  statusEmoji: true,
  bio: true,
  bannerUrl: true,
  pronouns: true,
  presence: true,
  isBot: true,
} as const;

/**
 * Spread alongside VIDEO_TAGS_INCLUDE anywhere a video is serialized for display, so a stitch or
 * duet always arrives with its attribution attached. Without it the credit silently renders as
 * absent, which for this feature is not a cosmetic bug — an uncredited remix is exactly what the
 * whole lineage model exists to prevent.
 */
export const VIDEO_SOURCE_INCLUDE = {
  sourceVideo: {
    select: {
      id: true,
      caption: true,
      thumbnailKey: true,
      author: { select: VIDEO_AUTHOR_SELECT },
    },
  },
} as const;
