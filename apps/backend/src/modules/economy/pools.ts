import { prisma } from "../../db/prisma.js";
import { allocatePool } from "./split.js";
import { PRODUCTS, recordRevenueEvent, qualifyAndPost } from "./service.js";
import { isUserBanned } from "../bans/service.js";

/**
 * Daily revenue pools — §11.2 of the economy design. Realized ad spend for a completed UTC day
 * becomes a pool; the pool is allocated across creators by that day's qualified views; each
 * creator's slice then flows through the SAME funnel every other product uses
 * (recordRevenueEvent → qualifyAndPost), so the ad pool gets policy versioning, the 55/45 split,
 * the reserve carve, the hold window, and the ledger for free — and cannot bypass any of them.
 *
 * Idempotency is layered: the per-creator revenue events dedupe on `adpool:<day>:<creator>`, so a
 * sweep that crashes mid-day re-runs safely; the PoolRun row is written LAST, purely as the
 * completion marker that stops a finished day from being re-scanned.
 */

/** How many completed days back the sweep will look for unprocessed pools. Bounds the work when
 * the worker has been down, and stops ancient days (with no view rollups) from churning forever. */
const LOOKBACK_DAYS = 7;

export function utcMidnight(d: Date): Date {
  const day = new Date(d);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/**
 * Pure aggregation: per-day view rows → per-creator weights. Only APPROVED videos with a living
 * author count; everything else earns nothing. Kept free of IO so it can be unit-tested.
 */
export function aggregateViewWeights(
  rows: { views: number; authorId: string | null; videoStatus: string }[],
): Map<string, bigint> {
  const weights = new Map<string, bigint>();
  for (const row of rows) {
    if (!row.authorId || row.videoStatus !== "APPROVED" || row.views <= 0) continue;
    weights.set(row.authorId, (weights.get(row.authorId) ?? 0n) + BigInt(row.views));
  }
  return weights;
}

/**
 * Run the ad pool for one completed UTC day. Safe to call repeatedly — a recorded day is a no-op,
 * and a partially-posted day resumes through the idempotency keys.
 */
export async function runAdPoolForDay(day: Date): Promise<void> {
  const product = PRODUCTS.AD_FEED;
  const existing = await prisma.poolRun.findUnique({ where: { product_day: { product, day } } });
  if (existing) return;

  // The pool: ad spend actually realized (delivered impressions) that day, in cents = USD minor.
  const spend = await prisma.adCampaignDaily.aggregate({ where: { day }, _sum: { spentCents: true } });
  const poolMinor = BigInt(spend._sum.spentCents ?? 0);
  if (poolMinor <= 0n) {
    await prisma.poolRun.create({ data: { product, day, poolMinor, status: "EMPTY_POOL" } });
    return;
  }

  const viewRows = await prisma.videoViewDay.findMany({
    where: { day },
    select: { views: true, video: { select: { authorId: true, status: true } } },
  });
  const rawWeights = aggregateViewWeights(
    viewRows.map((r) => ({ views: r.views, authorId: r.video.authorId, videoStatus: r.video.status })),
  );

  // Disqualify before allocating, so an ineligible creator's views don't strand a slice of the
  // pool — the remaining creators divide the whole creator share. qualifyAndPost re-checks each
  // event anyway (defense in depth; a ban landing between here and posting still excludes).
  const candidates = [...rawWeights.keys()];
  const adults = candidates.length
    ? await prisma.user.findMany({
        where: { id: { in: candidates }, isMinor: false, ageRecordedAt: { not: null } },
        select: { id: true },
      })
    : [];
  const weights: { key: string; weight: bigint }[] = [];
  for (const { id } of adults) {
    if (await isUserBanned(id)) continue;
    weights.push({ key: id, weight: rawWeights.get(id)! });
  }

  if (weights.length === 0) {
    await prisma.poolRun.create({ data: { product, day, poolMinor, status: "NO_QUALIFIED_VIEWS" } });
    return;
  }

  const { allocations, residualMinor } = allocatePool(poolMinor, weights);
  const dayKey = day.toISOString().slice(0, 10);
  for (const [creatorId, grossMinor] of allocations) {
    const event = await recordRevenueEvent({
      eventType: "ad_feed.pool",
      idempotencyKey: `adpool:${dayKey}:${creatorId}`,
      source: "worker.adpool",
      occurredAt: day,
      currency: "usd",
      grossMinor,
      creatorId,
      contentRef: `adpool:${dayKey}`,
    });
    await qualifyAndPost(event.id, { fundingAccount: "PROCESSOR_CLEARING" });
  }

  await prisma.poolRun.create({
    data: { product, day, poolMinor, status: "POSTED", creatorCount: allocations.size, residualMinor },
  });
}

/** Sweep every completed-but-unprocessed day in the lookback window. Called from the worker tick. */
export async function sweepAdPools(now = new Date()): Promise<void> {
  for (let offset = LOOKBACK_DAYS; offset >= 1; offset--) {
    const day = utcMidnight(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000));
    await runAdPoolForDay(day);
  }
}
