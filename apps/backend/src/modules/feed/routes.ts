import type { FastifyInstance } from "fastify";
import { pushInboxNotification } from "../inbox/service.js";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { NotFoundError, BadRequestError } from "../../lib/errors.js";
import { serializeVideo, VIDEO_AUTHOR_SELECT, VIDEO_TAGS_INCLUDE, VIDEO_SOURCE_INCLUDE } from "../videos/serialize.js";
import { adSlotIndexes, eligibleCampaigns, selectForSlots } from "../ads/delivery.js";
import { rankVideos } from "./ranking.js";
import { getTasteProfile, videoAffinity, invalidateTasteProfile } from "./taste.js";
import { requireAdult } from "../age/guard.js";

/** How many approved videos the ranker considers before slicing a page out. Bounded so the query
 * stays cheap as the table grows; a larger window would mean ranking the whole table on every
 * scroll. */
const CANDIDATE_WINDOW = 300;
const DEFAULT_PAGE = 10;
const MAX_PAGE = 30;

/** A view from the same user for the same video inside this window doesn't count again. Long enough
 * that scrolling back up a few cards isn't inflation, short enough that watching something again
 * tomorrow does count. */
const VIEW_DEDUPE_TTL_SEC = 6 * 60 * 60;

/** Mounted under /api/feed */
export default async function feedRoutes(fastify: FastifyInstance) {
  /**
   * The "For You" feed.
   *
   * Paginated by OFFSET against a ranked candidate window, not by the id cursor used everywhere
   * else in this codebase — a ranked order isn't monotonic in id, so `id < cursor` would skip and
   * repeat items arbitrarily. The `seed` returned with page 1 must be passed back on later pages:
   * it pins the jitter so the ranking stays identical across the whole scroll session. Without it
   * every page would re-rank independently and items would duplicate between pages.
   */
  fastify.get("/", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const userId = request.userId!;
    const query = request.query as { offset?: string; limit?: string; seed?: string; tag?: string };
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(query.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE));
    const seed = Number(query.seed) || Math.floor(Math.random() * 1_000_000);

    const candidates = await prisma.video.findMany({
      // Only APPROVED is ever public. Everything else — pending, rejected, removed, failed, still
      // processing — is invisible here regardless of who is asking.
      where: {
        status: "APPROVED",
        playbackKey: { not: null },
        // Tag filter, matched on the normalised name so "Gaming" and "gaming" find the same feed.
        ...(query.tag ? { tags: { some: { tag: { name: query.tag.trim().toLowerCase() } } } } : {}),
      },
      orderBy: { id: "desc" },
      take: CANDIDATE_WINDOW,
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });

    // Personalisation is a tilt on the same ranking everyone else gets, not a separate feed: the
    // profile can only lift videos whose tags or author the viewer has engaged with. A viewer with
    // no history has an empty profile and sees exactly the unpersonalised order.
    const profile = await getTasteProfile(userId);
    const ranked = rankVideos(candidates, seed, Date.now(), (v) => videoAffinity(profile, v));
    const page = ranked.slice(offset, offset + limit);
    const liked = await likedSet(userId, page.map((v) => v.id));

    const videos = page.map((v) => serializeVideo(v, liked.has(v.id)));

    // Promoted videos are interleaved here rather than mixed into the ranking, and that separation
    // is deliberate: an ad that competed on rank would let money buy its way up the organic feed,
    // and the density would rise with demand. Fixed slots mean more advertisers queue for the same
    // number of placements instead of the feed getting worse. Tag filters and paid promotion don't
    // mix either — someone who asked for one tag gets what they asked for.
    if (!query.tag) {
      const slots = adSlotIndexes(videos.length);
      if (slots.length > 0) {
        const campaigns = await eligibleCampaigns();
        const viewerTags = [...new Set(videos.flatMap((v) => v.tags))];
        const picked = selectForSlots(campaigns, slots.length, userId, viewerTags);

        if (picked.length > 0) {
          const adVideos = await prisma.video.findMany({
            // Restated even though eligibleCampaigns() already filtered on the video's status: that
            // filter ran moments earlier in the same request, and every other place a video reaches
            // a viewer re-checks status: "APPROVED" in its own where-clause rather than trusting an
            // earlier query — a takedown landing in the gap between the two queries is a narrow
            // window, but this is the one public video query that didn't close it.
            where: { id: { in: picked.map((c) => c.videoId) }, status: "APPROVED", playbackKey: { not: null } },
            include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
          });
          const byId = new Map(adVideos.map((v) => [v.id.toString(), v]));

          // Inserted back-to-front so each insertion doesn't shift the slots after it.
          for (let i = picked.length - 1; i >= 0; i--) {
            const campaign = picked[i];
            const video = byId.get(campaign.videoId.toString());
            if (!video || slots[i] === undefined) continue;
            videos.splice(slots[i], 0, {
              ...serializeVideo(video, liked.has(video.id)),
              // The client renders the Sponsored label from this and beacons impressions against
              // it. A promoted card is otherwise the same component as an organic one.
              sponsoredBy: campaign.id,
            });
          }
        }
      }
    }

    return {
      seed,
      nextOffset: offset + page.length < ranked.length ? offset + page.length : null,
      videos,
    };
  });

  /**
   * "Following" — videos from people the user is actually friends with. Reuses the existing
   * accepted-friend graph rather than introducing a separate follow model, which would be a second
   * social graph to keep coherent for very little gain on an instance this size.
   *
   * Chronological, and cursor-paginated on id like the rest of the codebase: there's no ranking to
   * break monotonicity here.
   */
  fastify.get("/following", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const userId = request.userId!;
    const query = request.query as { before?: string; limit?: string };
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(query.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE));
    let cursor: bigint | undefined;
    if (query.before) {
      try {
        cursor = BigInt(query.before);
      } catch {
        cursor = undefined;
      }
    }

    const friendships = await prisma.friendRequest.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const friendIds = friendships.map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId));

    if (friendIds.length === 0) return { videos: [], nextCursor: null };

    const videos = await prisma.video.findMany({
      where: {
        status: "APPROVED",
        playbackKey: { not: null },
        authorId: { in: friendIds },
        ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit,
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });

    const liked = await likedSet(userId, videos.map((v) => v.id));
    return {
      videos: videos.map((v) => serializeVideo(v, liked.has(v.id))),
      nextCursor: videos.length === limit ? videos[videos.length - 1].id.toString() : null,
    };
  });

  fastify.post("/:id/like", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const videoId = parseVideoId((request.params as { id: string }).id);
    const userId = request.userId!;
    await assertApproved(videoId);

    // createMany + skipDuplicates makes a repeat like a no-op rather than a 409, and keeps the
    // counter honest: the increment only runs when a row was actually inserted.
    // A like is the strongest taste signal there is, so the cached profile is dropped immediately
    // rather than left to expire — otherwise liking something has no visible effect on the feed
    // for up to the cache TTL, which reads as the like doing nothing.
    void invalidateTasteProfile(userId);
    const created = await prisma.videoLike.createMany({
      data: [{ videoId, userId }],
      skipDuplicates: true,
    });
    if (created.count > 0) {
      await prisma.video.update({ where: { id: videoId }, data: { likeCount: { increment: 1 } } });
      // "Someone liked your video" — the creator comeback trigger, bundled per video.
      void (async () => {
        const video = await prisma.video.findUnique({ where: { id: videoId }, select: { authorId: true, caption: true } });
        if (video?.authorId) {
          await pushInboxNotification({
            userId: video.authorId,
            kind: "VIDEO_LIKE",
            bundleKey: `VIDEO_LIKE:${videoId}`,
            actorId: userId,
            videoId: videoId.toString(),
            preview: video.caption?.slice(0, 140) ?? null,
          });
        }
      })().catch(() => undefined);
    }
    const video = await prisma.video.findUnique({ where: { id: videoId }, select: { likeCount: true } });
    return { liked: true, likeCount: video?.likeCount ?? 0 };
  });

  fastify.delete("/:id/like", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const videoId = parseVideoId((request.params as { id: string }).id);
    const userId = request.userId!;

    void invalidateTasteProfile(userId);
    const deleted = await prisma.videoLike.deleteMany({ where: { videoId, userId } });
    if (deleted.count > 0) {
      await prisma.video.update({ where: { id: videoId }, data: { likeCount: { decrement: 1 } } });
    }
    const video = await prisma.video.findUnique({ where: { id: videoId }, select: { likeCount: true } });
    return { liked: false, likeCount: video?.likeCount ?? 0 };
  });

  /**
   * Records a view. Deduped per (user, video) in Redis for a few hours rather than by persisting a
   * row per view, which would grow without bound and buy nothing — the only consumer is a counter.
   *
   * Best-effort by design: if Redis is unavailable the view is skipped rather than failing the
   * request or risking a double count. A view counter is not worth an error toast.
   */
  fastify.post("/:id/view", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const videoId = parseVideoId((request.params as { id: string }).id);
    const userId = request.userId!;

    try {
      const key = `videoview:${videoId}:${userId}`;
      const first = await redis.set(key, "1", "EX", VIEW_DEDUPE_TTL_SEC, "NX");
      if (first === "OK") {
        await prisma.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 } } });
        // Same deduped view, rolled up per UTC day — the weight the daily ad pool pays on
        // (economy/pools.ts). One dedupe deciding both keeps the paid number and the shown
        // number the same fact.
        const day = new Date();
        day.setUTCHours(0, 0, 0, 0);
        await prisma.videoViewDay.upsert({
          where: { videoId_day: { videoId, day } },
          create: { videoId, day, views: 1 },
          update: { views: { increment: 1 } },
        });
      }
    } catch {
      /* counting a view must never break playback */
    }
    return { ok: true };
  });
}

function parseVideoId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new BadRequestError("Invalid video id");
  }
}

/** Liking something that isn't published shouldn't be possible even by direct API call — otherwise
 * a guessed id lets someone interact with a pending or rejected upload. */
async function assertApproved(videoId: bigint): Promise<void> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { status: true } });
  if (!video || video.status !== "APPROVED") throw new NotFoundError("Video not found");
}

/** One query for the whole page's like state instead of N — the alternative is a per-card round
 * trip, which is the classic way a feed ends up making 30 queries to render 10 items. */
async function likedSet(userId: string, videoIds: bigint[]): Promise<Set<bigint>> {
  if (videoIds.length === 0) return new Set();
  const rows = await prisma.videoLike.findMany({
    where: { userId, videoId: { in: videoIds } },
    select: { videoId: true },
  });
  return new Set(rows.map((r) => r.videoId));
}
