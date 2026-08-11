/**
 * Feed ranking, isolated in one module so it can be replaced wholesale later without touching any
 * route.
 *
 * This is explicitly NOT a recommender. There is no per-user model, no collaborative filtering and
 * no learned weights — on an instance with a few hundred videos there is nothing to learn from, and
 * pretending otherwise would just be an opaque way to sort by luck. What it does instead is a
 * transparent score: fresh things surface, things people actually watched through and liked surface
 * a bit more, and a small deterministic jitter keeps two people opening the app at the same moment
 * from seeing an identical order.
 */

import { PERSONAL_WEIGHT } from "./taste.js";

export interface RankableVideo {
  id: bigint;
  createdAt: Date;
  likeCount: number;
  viewCount: number;
}

/** Engagement stops helping past this point, so one runaway video can't occupy the top of the feed
 * indefinitely. */
const ENGAGEMENT_CAP = 1;
/** Score halves roughly every day and a half; new uploads stay findable on a small instance without
 * old ones being unreachable. */
const HALF_LIFE_HOURS = 36;

/**
 * Deterministic per-(video, seed) jitter in [0, 1). Deterministic matters: pagination would break
 * if the same video scored differently between page 1 and page 2 of the same session, which is
 * exactly what Math.random() here would cause — items would duplicate across pages and others would
 * never appear at all.
 */
function jitter(videoId: bigint, seed: number): number {
  let h = (Number(videoId % 100000n) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function scoreVideo(
  video: RankableVideo,
  seed: number,
  now = Date.now(),
  /** Optional per-viewer affinity in 0..1 (see feed/taste.ts). Omitted or 0 leaves the score
   * exactly as it was before personalisation existed. */
  affinity = 0,
): number {
  const ageHours = Math.max(0, (now - video.createdAt.getTime()) / 3_600_000);
  const recency = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);

  // Like rate rather than raw likes, so a video with 5 likes from 10 views isn't buried under one
  // with 50 likes from 5000. Videos below a handful of views fall back to neutral instead of
  // being scored on a meaningless ratio (1 like / 1 view is not a 100% hit rate).
  const engagement =
    video.viewCount >= 5
      ? Math.min(ENGAGEMENT_CAP, video.likeCount / video.viewCount)
      : 0.15;

  const base = recency * 0.65 + engagement * 0.25 + jitter(video.id, seed) * 0.1;

  // Multiplicative and one-directional: affinity can only ever LIFT a video. Nothing is pushed
  // down for being unfamiliar, so a topic the viewer has never engaged with can still surface on
  // its own recency and engagement — which is the only way anyone ever discovers a new topic, and
  // the only way this behaves sanely on an instance with barely any engagement history to read.
  return base * (1 + PERSONAL_WEIGHT * Math.max(0, Math.min(1, affinity)));
}

/**
 * Sorted best-first. Ties break on id so the order is total and stable across pages.
 *
 * `affinityOf` is how personalisation enters: the caller supplies it (feed/routes.ts builds it
 * from a TasteProfile) and this module stays free of any database access, so the scoring rules
 * remain testable as pure functions.
 */
export function rankVideos<T extends RankableVideo>(
  videos: T[],
  seed: number,
  now = Date.now(),
  affinityOf?: (video: T) => number,
): T[] {
  const ranked = [...videos]
    .map((v) => ({ v, score: scoreVideo(v, seed, now, affinityOf ? affinityOf(v) : 0) }))
    .sort((a, b) => b.score - a.score || Number(b.v.id - a.v.id))
    .map((x) => x.v);
  return spreadAuthors(ranked);
}

/** How many videos from one author may appear consecutively before the next one is deferred. */
const MAX_RUN_PER_AUTHOR = 2;

/**
 * Breaks up consecutive runs from the same uploader.
 *
 * Author affinity plus a prolific uploader is enough to hand someone six clips from one account in
 * a row, which reads as a broken feed rather than as a good recommendation. This defers the
 * offending item rather than dropping it — nothing is ever removed from the feed by this pass, only
 * moved later — so a small instance where one account posted everything still shows everything.
 */
function spreadAuthors<T extends RankableVideo>(ranked: T[]): T[] {
  const out: T[] = [];
  const deferred: T[] = [];
  let lastAuthor: string | null | undefined;
  let run = 0;

  for (const v of ranked) {
    const author = (v as unknown as { authorId?: string | null }).authorId;
    if (author && author === lastAuthor && run >= MAX_RUN_PER_AUTHOR) {
      deferred.push(v);
      continue;
    }
    run = author && author === lastAuthor ? run + 1 : 1;
    lastAuthor = author;
    out.push(v);
  }
  return [...out, ...deferred];
}
