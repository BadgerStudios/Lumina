import { createHash } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";

/**
 * Bandwidth accounting.
 *
 * Kept entirely in Redis counters rather than a table, because this increments on EVERY media
 * request — a row (or even an upsert) per video chunk served would be a write amplification problem
 * far larger than the thing being measured. Redis INCRBY is cheap enough to sit in the hot path.
 *
 * Keys are per-day and per-category with a 90-day TTL, so the data expires itself and never needs
 * pruning. Losing these counters to a Redis restart loses analytics, nothing else — which is exactly
 * the right trade for a metric.
 */
const BANDWIDTH_TTL_SEC = 90 * 24 * 60 * 60;

export type BandwidthCategory = "video" | "attachment" | "download";

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function bandwidthKey(category: BandwidthCategory, day: string): string {
  return `bw:${category}:${day}`;
}

/** Fire-and-forget: metering must never fail or delay the response it is measuring. */
export function recordBandwidth(category: BandwidthCategory, bytes: number): void {
  if (bytes <= 0) return;
  const key = bandwidthKey(category, dayKey());
  void redis
    .incrby(key, bytes)
    .then(() => redis.expire(key, BANDWIDTH_TTL_SEC))
    .catch(() => undefined);
}

export interface BandwidthDay {
  date: string;
  video: number;
  attachment: number;
  download: number;
  total: number;
}

export async function getBandwidthSeries(days: number): Promise<BandwidthDay[]> {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }

  const categories: BandwidthCategory[] = ["video", "attachment", "download"];
  // One pipelined round trip for the whole window rather than days × categories separate calls.
  const pipeline = redis.pipeline();
  for (const date of dates) {
    for (const category of categories) pipeline.get(bandwidthKey(category, date));
  }

  let values: Array<string | null> = [];
  try {
    const replies = await pipeline.exec();
    values = (replies ?? []).map((r) => (r?.[1] as string | null) ?? null);
  } catch {
    values = [];
  }

  return dates.map((date, dayIndex) => {
    const base = dayIndex * categories.length;
    const video = Number(values[base] ?? 0) || 0;
    const attachment = Number(values[base + 1] ?? 0) || 0;
    const download = Number(values[base + 2] ?? 0) || 0;
    return { date, video, attachment, download, total: video + attachment + download };
  });
}

/** IPs are hashed for download analytics — knowing how many distinct people downloaded a release
 * does not require being able to identify any of them. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.JWT_ACCESS_SECRET ?? "";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export async function recordAppDownload(params: {
  platform: string;
  fileName: string;
  version?: string | null;
  ip?: string;
  userAgent?: string;
  country?: string | null;
}): Promise<void> {
  try {
    await prisma.appDownload.create({
      data: {
        platform: params.platform,
        fileName: params.fileName,
        version: params.version ?? null,
        ipHash: hashIp(params.ip),
        userAgent: params.userAgent?.slice(0, 300) ?? null,
        country: params.country ?? null,
      },
    });
  } catch {
    /* analytics must never break the download itself */
  }
}

export interface DownloadStats {
  total: number;
  last7Days: number;
  byPlatform: Array<{ platform: string; count: number }>;
  series: Array<{ date: string; count: number }>;
}

export async function getDownloadStats(days = 30): Promise<DownloadStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [total, last7Days, byPlatform, recent] = await Promise.all([
    prisma.appDownload.count(),
    prisma.appDownload.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.appDownload.groupBy({ by: ["platform"], _count: { _all: true } }),
    prisma.appDownload.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    }),
  ]);

  // Bucketed in application code rather than with a raw date_trunc query: the volume here is small,
  // and this keeps the whole thing portable and readable.
  const counts = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    counts.set(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)), 0);
  }
  for (const row of recent) {
    const key = dayKey(row.createdAt);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    total,
    last7Days,
    byPlatform: byPlatform.map((p) => ({ platform: p.platform, count: p._count._all })),
    series: Array.from(counts.entries()).map(([date, count]) => ({ date, count })),
  };
}

export interface RevenueStats {
  configured: boolean;
  currency: string;
  grossCents: number;
  refundedCents: number;
  netCents: number;
  last30DaysCents: number;
  activeSubscriptions: number;
  series: Array<{ date: string; cents: number }>;
}

/**
 * Revenue, computed entirely from the local Transaction ledger (written only from signature-verified
 * Stripe webhooks). `configured` is reported alongside so the dashboard can distinguish "no billing
 * system connected" from "billing connected and genuinely zero" — those look identical otherwise,
 * and conflating them is how a dashboard ends up lying.
 */
export async function getRevenueStats(configured: boolean, days = 30): Promise<RevenueStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [charges, refunds, recent, activeSubscriptions] = await Promise.all([
    prisma.transaction.aggregate({ where: { kind: "CHARGE" }, _sum: { amountCents: true } }),
    prisma.transaction.aggregate({ where: { kind: "REFUND" }, _sum: { amountCents: true } }),
    prisma.transaction.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, amountCents: true, kind: true },
    }),
    prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
  ]);

  const grossCents = charges._sum.amountCents ?? 0;
  const refundedCents = refunds._sum.amountCents ?? 0;

  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(dayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000)), 0);
  }
  let last30DaysCents = 0;
  for (const t of recent) {
    // A refund reduces revenue rather than adding to it — netting them here is what makes the
    // series honest instead of a gross-only vanity number.
    const signed = t.kind === "REFUND" ? -t.amountCents : t.amountCents;
    last30DaysCents += signed;
    const key = dayKey(t.createdAt);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + signed);
  }

  return {
    configured,
    currency: "usd",
    grossCents,
    refundedCents,
    netCents: grossCents - refundedCents,
    last30DaysCents,
    activeSubscriptions,
    series: Array.from(buckets.entries()).map(([date, cents]) => ({ date, cents })),
  };
}
