import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";

/**
 * What a person appears to be interested in, derived from what they have actually done.
 *
 * ## Scope, stated honestly
 *
 * This is not a recommender in the machine-learning sense and does not pretend to be. There is
 * nothing to learn from on an instance with a few dozen videos and a handful of likes — a model
 * would be an opaque way to sort by noise. What this does is transparent and explainable in one
 * sentence: videos carrying tags you have engaged with, or made by people you have engaged with,
 * score higher than ones that don't.
 *
 * ## The two things it deliberately will NOT do
 *
 * **It never penalises unfamiliar content.** The affinity term is a multiplicative bonus in
 * [1, 1+PERSONAL_WEIGHT] — matching content is lifted, non-matching content is left exactly where
 * the base ranking put it. A scheme that subtracts for "unlike your history" builds a filter bubble
 * that a new topic can never escape, and on a small instance it would empty the feed outright.
 *
 * **It never replaces the base ranking.** Recency and engagement still decide most of the order.
 * A feed that only shows what you already liked stops being a feed and becomes a mirror.
 */

/** Engagement kinds, weighted by how much intent each one actually expresses. A like is a
 * deliberate signal; posting about something is strong but is about what you make rather than what
 * you want to watch, so it counts for less. */
const WEIGHT_LIKE = 1.0;
const WEIGHT_COMMENT = 0.8;
const WEIGHT_OWN_UPLOAD = 0.5;

/** How far the profile can lift a video's score. 0.6 means a perfect match can score 60% above an
 * identical video with no affinity — enough to reorder a page, not enough to bury fresh content. */
export const PERSONAL_WEIGHT = 0.6;

/** How much of the affinity comes from tags versus the author. Tags generalise (liking one reef
 * video says something about reef videos in general); an author is narrower but a stronger signal
 * when it fires. */
const TAG_SHARE = 0.65;
const AUTHOR_SHARE = 0.35;

/** How many recent engagements to read. Bounded so the profile query cost doesn't grow with an
 * enthusiastic user's entire history, and recency-limited because taste moves. */
const HISTORY_LIMIT = 200;

const CACHE_TTL_SEC = 600;
const cacheKey = (userId: string) => `taste:v1:${userId}`;

export interface TasteProfile {
  /** tag name -> 0..1 */
  tagWeights: Record<string, number>;
  /** author user id -> 0..1 */
  authorWeights: Record<string, number>;
  /** True when the user has engaged with nothing yet — the caller can then skip the whole
   * personalisation path rather than multiplying everything by 1. */
  empty: boolean;
}

const EMPTY: TasteProfile = { tagWeights: {}, authorWeights: {}, empty: true };

/** Scales a raw weight map into 0..1 against its own maximum, so a user with 3 likes and one with
 * 300 both get a profile whose strongest signal is 1.0. Without this, a heavy user's affinities
 * would dominate the multiplicative bonus while a light user's would round to nothing. */
function normalise(raw: Map<string, number>): Record<string, number> {
  const max = Math.max(...raw.values(), 0);
  if (max <= 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of raw) out[k] = v / max;
  return out;
}

async function computeProfile(userId: string): Promise<TasteProfile> {
  const [likes, comments, own] = await Promise.all([
    prisma.videoLike.findMany({
      where: { userId },
      take: HISTORY_LIMIT,
      orderBy: { videoId: "desc" },
      select: { video: { select: { authorId: true, tags: { select: { tag: { select: { name: true } } } } } } },
    }),
    prisma.videoComment.findMany({
      where: { authorId: userId },
      take: HISTORY_LIMIT,
      orderBy: { id: "desc" },
      select: {
        video: { select: { authorId: true, tags: { select: { tag: { select: { name: true } } } } } },
      },
    }),
    prisma.video.findMany({
      where: { authorId: userId },
      take: HISTORY_LIMIT,
      orderBy: { id: "desc" },
      select: { tags: { select: { tag: { select: { name: true } } } } },
    }),
  ]);

  const tagRaw = new Map<string, number>();
  const authorRaw = new Map<string, number>();
  const addTag = (name: string, w: number) => tagRaw.set(name, (tagRaw.get(name) ?? 0) + w);
  const addAuthor = (id: string | null, w: number) => {
    // Never build affinity toward yourself: your own uploads would otherwise dominate your feed.
    if (!id || id === userId) return;
    authorRaw.set(id, (authorRaw.get(id) ?? 0) + w);
  };

  for (const l of likes) {
    if (!l.video) continue;
    addAuthor(l.video.authorId, WEIGHT_LIKE);
    for (const t of l.video.tags) addTag(t.tag.name, WEIGHT_LIKE);
  }
  for (const c of comments) {
    if (!c.video) continue;
    addAuthor(c.video.authorId, WEIGHT_COMMENT);
    for (const t of c.video.tags) addTag(t.tag.name, WEIGHT_COMMENT);
  }
  for (const v of own) {
    for (const t of v.tags) addTag(t.tag.name, WEIGHT_OWN_UPLOAD);
  }

  if (tagRaw.size === 0 && authorRaw.size === 0) return EMPTY;

  // Discount tags by how common they are, before normalising.
  //
  // Without this the profile is dominated by whatever tag everyone uses. Liking one #geology clip
  // on this instance also credits #nature, which sits on nine videos out of ten — so every video
  // gets the same boost, and a uniform multiplier cannot reorder anything. Personalisation then
  // silently does nothing while appearing to work.
  //
  // It is the same correction as inverse-degree weighting on mutual friends: evidence is worth
  // less the more indiscriminately it applies. A tag on 90% of the library says almost nothing
  // about taste; a tag on 5% says a great deal. Tag.useCount is already denormalised for the
  // typeahead, so this costs one small indexed read rather than a count per tag.
  const [tagRows, totalVideos] = await Promise.all([
    prisma.tag.findMany({ where: { name: { in: [...tagRaw.keys()] } }, select: { name: true, useCount: true } }),
    prisma.video.count({ where: { status: "APPROVED" } }),
  ]);
  const useCountByName = new Map(tagRows.map((t) => [t.name, t.useCount]));
  for (const [name, weight] of tagRaw) {
    const useCount = useCountByName.get(name) ?? 1;
    const idf = Math.log(1 + Math.max(1, totalVideos) / (1 + useCount));
    tagRaw.set(name, weight * idf);
  }

  return { tagWeights: normalise(tagRaw), authorWeights: normalise(authorRaw), empty: false };
}

/**
 * The profile, cached briefly.
 *
 * Cache, not store: it is derived data that can be rebuilt from the tables at any time, so a lost
 * Redis costs one recomputation and nothing else. That is the opposite of the friend-suggestion
 * dismissals, which had to go in Postgres precisely because they could not be rebuilt.
 */
export async function getTasteProfile(userId: string): Promise<TasteProfile> {
  try {
    const cached = await redis.get(cacheKey(userId));
    if (cached) return JSON.parse(cached) as TasteProfile;
  } catch {
    /* fall through and compute */
  }

  const profile = await computeProfile(userId);

  try {
    await redis.set(cacheKey(userId), JSON.stringify(profile), "EX", CACHE_TTL_SEC);
  } catch {
    /* caching is an optimisation, not a requirement */
  }
  return profile;
}

/** Invalidated on the actions that change it, so a like visibly affects the next scroll rather
 * than up to ten minutes later. */
export async function invalidateTasteProfile(userId: string): Promise<void> {
  try {
    await redis.del(cacheKey(userId));
  } catch {
    /* the TTL will catch it */
  }
}

/**
 * Affinity of one video for one profile, in 0..1.
 *
 * Tag affinity is the MAXIMUM matching tag weight rather than the mean: a video tagged
 * ["ocean", "nature", "documentary"] shown to someone who loves ocean content should score on the
 * ocean match, not have it diluted by two tags they've never engaged with. Averaging punishes
 * well-tagged videos, which is precisely backwards.
 */
export function videoAffinity(
  profile: TasteProfile,
  video: { authorId: string | null; tags: Array<{ tag: { name: string } }> },
): number {
  if (profile.empty) return 0;

  let tagScore = 0;
  for (const t of video.tags) {
    const w = profile.tagWeights[t.tag.name];
    if (w !== undefined && w > tagScore) tagScore = w;
  }
  const authorScore = video.authorId ? (profile.authorWeights[video.authorId] ?? 0) : 0;

  return Math.min(1, tagScore * TAG_SHARE + authorScore * AUTHOR_SHARE);
}
