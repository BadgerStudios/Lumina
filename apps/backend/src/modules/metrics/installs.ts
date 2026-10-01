import { prisma } from "../../db/prisma.js";
import { isFcmConfigured, validateFcmToken } from "../../lib/fcm.js";

/**
 * Lost installs: apps that were uninstalled (or had their data cleared). Android tells nobody when
 * an app is removed; the only trace is that its FCM token stops working. So a loss is recorded at
 * the moment a token is found dead - by a notification bouncing, or by the daily sweep, which asks
 * FCM about every token with a validate-only send that delivers nothing.
 *
 * FCM can also rotate a token on a phone that still has the app. The app then registers the new
 * one, and that re-registration marks the loss recovered - so what's counted is the install that
 * did not come back.
 */

export const RECOVERY_DAYS = 7;

interface TokenRow {
  id: string;
  userId: string;
  app: string;
  platform: string;
  build: number | null;
  createdAt: Date;
}

/** Deletes a dead token and records the lost install. Safe to call twice for the same row. */
export async function recordInstallLoss(row: TokenRow, detectedBy: "send" | "sweep"): Promise<void> {
  // The delete decides who records: only the caller that actually removed the row writes the loss,
  // so a send and the sweep finding the same dead token at once can't count it twice.
  const { count } = await prisma.deviceToken.deleteMany({ where: { id: row.id } });
  if (count === 0) return;
  await prisma.appInstallLoss
    .create({
      data: { userId: row.userId, app: row.app, platform: row.platform, build: row.build, installedAt: row.createdAt, detectedBy },
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[installs] could not record a lost install:", (err as Error)?.message);
    });
}

/** Called when a device registers: an install that "died" recently and came straight back was a token rotation or a reinstall. */
export async function markInstallRecovered(userId: string, app: string, platform: string): Promise<void> {
  const since = new Date(Date.now() - RECOVERY_DAYS * 24 * 60 * 60 * 1000);
  await prisma.appInstallLoss
    .updateMany({ where: { userId, app, platform, recoveredAt: null, lostAt: { gte: since } }, data: { recoveredAt: new Date() } })
    .catch(() => {});
}

/**
 * The daily sweep. Sequential and paced: the volume is small, and a burst of thousands of
 * validate calls is not worth the quota risk for a number read once a day.
 */
export async function sweepDeadDeviceTokens(): Promise<{ checked: number; lost: number; unknown: number }> {
  if (!isFcmConfigured()) return { checked: 0, lost: 0, unknown: 0 };
  let checked = 0;
  let lost = 0;
  let unknown = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.deviceToken.findMany({
      take: 200,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, token: true, userId: true, app: true, platform: true, build: true, createdAt: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      const state = await validateFcmToken(row.token);
      checked += 1;
      if (state === "dead") {
        await recordInstallLoss(row, "sweep");
        lost += 1;
      } else if (state === "unknown") {
        unknown += 1;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { checked, lost, unknown };
}

export interface InstallStats {
  /** Whether the uninstall signal exists at all (FCM configured). */
  tracking: boolean;
  /** App installs with notifications registered right now, by app. */
  activeInstalls: Array<{ app: string; platform: string; count: number }>;
  lostLast7Days: number;
  lostLast30Days: number;
  lostTotal: number;
  /** Accounts that lost the app and have no install of it left: users the app has lost. */
  lostUsers30Days: number;
  series: Array<{ date: string; lost: number; installed: number }>;
}

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function getInstallStats(days = 30): Promise<InstallStats> {
  const now = Date.now();
  const since = new Date(now - days * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const notRecovered = { recoveredAt: null };
  const [active, lost7, lost30, lostTotal, recentLosses, recentInstalls] = await Promise.all([
    prisma.deviceToken.groupBy({ by: ["app", "platform"], _count: { _all: true } }),
    prisma.appInstallLoss.count({ where: { ...notRecovered, lostAt: { gte: weekAgo } } }),
    prisma.appInstallLoss.count({ where: { ...notRecovered, lostAt: { gte: since } } }),
    prisma.appInstallLoss.count({ where: notRecovered }),
    prisma.appInstallLoss.findMany({ where: { ...notRecovered, lostAt: { gte: since } }, select: { lostAt: true, userId: true, app: true } }),
    prisma.deviceToken.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
  ]);

  // A lost user: lost an install in the window and holds no token for that app any more.
  const pairs = [...new Set(recentLosses.filter((l) => l.userId).map((l) => `${l.userId}|${l.app}`))];
  let lostUsers = 0;
  if (pairs.length) {
    const still = await prisma.deviceToken.findMany({
      where: { userId: { in: [...new Set(pairs.map((p) => p.split("|")[0]!))] } },
      select: { userId: true, app: true },
    });
    const has = new Set(still.map((t) => `${t.userId}|${t.app}`));
    lostUsers = new Set(pairs.filter((p) => !has.has(p)).map((p) => p.split("|")[0])).size;
  }

  const buckets = new Map<string, { lost: number; installed: number }>();
  for (let i = days - 1; i >= 0; i--) buckets.set(dayKey(new Date(now - i * 24 * 60 * 60 * 1000)), { lost: 0, installed: 0 });
  for (const l of recentLosses) {
    const b = buckets.get(dayKey(l.lostAt));
    if (b) b.lost += 1;
  }
  for (const t of recentInstalls) {
    const b = buckets.get(dayKey(t.createdAt));
    if (b) b.installed += 1;
  }

  return {
    tracking: isFcmConfigured(),
    activeInstalls: active.map((a) => ({ app: a.app, platform: a.platform, count: a._count._all })),
    lostLast7Days: lost7,
    lostLast30Days: lost30,
    lostTotal,
    lostUsers30Days: lostUsers,
    series: [...buckets.entries()].map(([date, v]) => ({ date, ...v })),
  };
}
