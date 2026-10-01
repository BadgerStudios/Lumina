import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { googleAccessToken, parseServiceAccount } from "../../lib/googleServiceAccount.js";

/**
 * Download and install numbers from outside Lumina's own site.
 *
 *  - GitHub releases: each asset's download_count is cumulative, so the hourly snapshot stores
 *    today's running total per platform and "this week" is today minus a week ago.
 *  - Google Play: Play Console exports a daily installs report (CSV, UTF-16) to a Cloud Storage
 *    bucket. Each row is one day, so it's stored per day: user installs, user uninstalls and active
 *    device installs. Needs PLAY_REPORTS_BUCKET and a service account Play Console has invited.
 *
 * Both are best-effort: a fetch that fails leaves the last good snapshot in place and is logged,
 * and a source that isn't set up reports "not connected" rather than a zero.
 */

function utcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function upsert(source: string, day: Date, metric: string, platform: string, value: number) {
  await prisma.storeStatsSnapshot.upsert({
    where: { source_day_metric_platform: { source, day, metric, platform } },
    create: { source, day, metric, platform, value },
    update: { value },
  });
}

// ---------------------------------------------------------------- GitHub

/** Which platform a release asset is for; null for checksums and anything that isn't an app. */
export function githubAssetPlatform(name: string): string | null {
  const n = name.toLowerCase();
  if (n.endsWith(".apk")) return n.includes("owner") ? "android-owner" : "android";
  if (n.endsWith(".appimage")) return "desktop-linux";
  if (n.endsWith(".exe") || (n.endsWith(".zip") && n.includes("win"))) return "desktop-windows";
  if (n.endsWith(".dmg")) return "desktop-mac";
  return null;
}

export async function refreshGithubDownloads(): Promise<Record<string, number> | null> {
  const totals: Record<string, number> = {};
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`https://api.github.com/repos/${env.GITHUB_RELEASES_REPO}/releases?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "lumina-backend",
          ...(env.GITHUB_STATS_TOKEN ? { Authorization: `Bearer ${env.GITHUB_STATS_TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const releases = (await res.json()) as Array<{ draft?: boolean; assets?: Array<{ name: string; download_count: number }> }>;
      for (const r of releases) {
        if (r.draft) continue;
        for (const a of r.assets ?? []) {
          const platform = githubAssetPlatform(a.name);
          if (platform) totals[platform] = (totals[platform] ?? 0) + (a.download_count ?? 0);
        }
      }
      if (releases.length < 100) break;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[store-stats] GitHub releases fetch failed:", (err as Error)?.message ?? err);
    return null;
  }
  const day = utcDay();
  for (const [platform, value] of Object.entries(totals)) await upsert("github", day, "downloads_total", platform, value);
  return totals;
}

// ---------------------------------------------------------------- Google Play

const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

function playAccount() {
  return (
    parseServiceAccount(env.PLAY_REPORTS_SA_JSON) ??
    parseServiceAccount(env.GOOGLE_PLAY_INTEGRITY_SA_JSON) ??
    parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON)
  );
}

export function playPackage(): string {
  return env.GOOGLE_PLAY_PACKAGE_NAME ?? "com.luxffa.lumina";
}

export function isPlayConnected(): boolean {
  return !!env.PLAY_REPORTS_BUCKET && playAccount() !== null;
}

/** Play's report CSVs are UTF-16LE with a BOM; tolerate UTF-8 too. */
export function decodeReport(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export interface PlayDay {
  day: string;
  installs: number | null;
  uninstalls: number | null;
  active: number | null;
}

/** Parses an installs "overview" report. Columns are matched by name, so a reordered export still reads. */
export function parsePlayInstallsCsv(text: string): PlayDay[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iDate = col("date");
  const iInstalls = col("daily user installs", "install events", "daily device installs");
  const iUninstalls = col("daily user uninstalls", "uninstall events", "daily device uninstalls");
  const iActive = col("active device installs", "total user installs");
  if (iDate < 0) return [];
  const num = (cells: string[], i: number) => {
    if (i < 0) return null;
    const n = Number((cells[i] ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const out: PlayDay[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const day = cells[iDate];
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({ day, installs: num(cells, iInstalls), uninstalls: num(cells, iUninstalls), active: num(cells, iActive) });
  }
  return out;
}

async function fetchPlayMonth(bucket: string, bearer: string, yyyymm: string): Promise<PlayDay[] | null> {
  const object = `stats/installs/installs_${playPackage()}_${yyyymm}_overview.csv`;
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`,
    { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(30_000) },
  );
  // A month with no report yet (the first day or two of a month) is not an error.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Cloud Storage ${res.status} for ${object}`);
  return parsePlayInstallsCsv(decodeReport(Buffer.from(await res.arrayBuffer())));
}

export async function refreshPlayStats(): Promise<number | null> {
  const bucket = env.PLAY_REPORTS_BUCKET?.replace(/^gs:\/\//, "").split("/")[0];
  const account = playAccount();
  if (!bucket || !account) return null;
  try {
    const bearer = await googleAccessToken(account, GCS_SCOPE);
    if (!bearer) throw new Error(`no access token for ${account.client_email}`);
    const now = new Date();
    // First run backfills two years (Play keeps the monthly files); after that the current and
    // previous month, since Play revises recent days for a while after first reporting them.
    const haveAny = (await prisma.storeStatsSnapshot.count({ where: { source: "play" } })) > 0;
    const months = Array.from({ length: haveAny ? 2 : 24 }, (_, back) => back).map((back) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    });
    let rows = 0;
    for (const m of months) {
      const days = await fetchPlayMonth(bucket, bearer, m);
      for (const d of days ?? []) {
        const day = new Date(`${d.day}T00:00:00Z`);
        if (d.installs != null) await upsert("play", day, "installs", "android", d.installs);
        if (d.uninstalls != null) await upsert("play", day, "uninstalls", "android", d.uninstalls);
        if (d.active != null) await upsert("play", day, "active_installs", "android", d.active);
        rows += 1;
      }
    }
    return rows;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[store-stats] Play report fetch failed:", (err as Error)?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------- read side

export interface StoreStats {
  github: {
    repo: string;
    total: number;
    last7Days: number;
    byPlatform: Array<{ platform: string; count: number }>;
    /** When the worker last fetched; a stale time is how a failing fetch shows (errors are in the worker log). */
    updatedAt: string | null;
  };
  play: {
    connected: boolean;
    /** Service account to invite in Play Console, when one exists but no bucket is set. */
    serviceAccount: string | null;
    installsTotal: number;
    installsLast7Days: number;
    uninstallsLast7Days: number;
    uninstallsLast30Days: number;
    activeInstalls: number | null;
    latestDay: string | null;
    updatedAt: string | null;
  };
  /** Per day, aligned with the site's own download series. */
  series: Array<{ date: string; github: number; playInstalls: number; playUninstalls: number }>;
}

export async function getStoreStats(days = 30): Promise<StoreStats> {
  const today = utcDay();
  const since = new Date(today.getTime() - (days + 1) * 86_400_000);
  const [gh, play] = await Promise.all([
    prisma.storeStatsSnapshot.findMany({ where: { source: "github", metric: "downloads_total" }, orderBy: { day: "asc" } }),
    prisma.storeStatsSnapshot.findMany({ where: { source: "play" }, orderBy: { day: "asc" } }),
  ]);

  // GitHub: latest cumulative total per platform, and the per-day increase between snapshots.
  const ghByDay = new Map<string, Map<string, number>>();
  let ghUpdated: Date | null = null;
  for (const r of gh) {
    const k = r.day.toISOString().slice(0, 10);
    if (!ghByDay.has(k)) ghByDay.set(k, new Map());
    ghByDay.get(k)!.set(r.platform, r.value);
    if (!ghUpdated || r.fetchedAt > ghUpdated) ghUpdated = r.fetchedAt;
  }
  const ghDays = [...ghByDay.keys()].sort();
  const totalOn = (k: string | undefined, userOnly = true) => {
    if (!k) return 0;
    let t = 0;
    for (const [p, v] of ghByDay.get(k) ?? []) if (!userOnly || p !== "android-owner") t += v;
    return t;
  };
  const latest = ghDays[ghDays.length - 1];
  const weekAgoKey = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const baseline = [...ghDays].reverse().find((k) => k <= weekAgoKey) ?? ghDays[0];
  const ghDaily = new Map<string, number>();
  for (let i = 1; i < ghDays.length; i++) ghDaily.set(ghDays[i]!, Math.max(0, totalOn(ghDays[i]) - totalOn(ghDays[i - 1])));

  // Play: per-day rows.
  const playDay = new Map<string, { installs: number; uninstalls: number; active: number | null }>();
  for (const r of play) {
    const k = r.day.toISOString().slice(0, 10);
    const e = playDay.get(k) ?? { installs: 0, uninstalls: 0, active: null };
    if (r.metric === "installs") e.installs = r.value;
    else if (r.metric === "uninstalls") e.uninstalls = r.value;
    else if (r.metric === "active_installs") e.active = r.value;
    playDay.set(k, e);
  }
  const playKeys = [...playDay.keys()].sort();
  const sumPlay = (field: "installs" | "uninstalls", fromKey: string) =>
    playKeys.filter((k) => k > fromKey).reduce((n, k) => n + playDay.get(k)![field], 0);
  const monthAgoKey = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const latestPlay = playKeys[playKeys.length - 1] ?? null;
  const account = playAccount();

  const series: StoreStats["series"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    if (new Date(k) < since) continue;
    series.push({ date: k, github: ghDaily.get(k) ?? 0, playInstalls: playDay.get(k)?.installs ?? 0, playUninstalls: playDay.get(k)?.uninstalls ?? 0 });
  }

  return {
    github: {
      repo: env.GITHUB_RELEASES_REPO,
      total: totalOn(latest),
      last7Days: latest && baseline && latest !== baseline ? Math.max(0, totalOn(latest) - totalOn(baseline)) : 0,
      byPlatform: [...(ghByDay.get(latest ?? "") ?? new Map<string, number>()).entries()].map(([platform, count]) => ({ platform, count })),
      updatedAt: ghUpdated?.toISOString() ?? null,
    },
    play: {
      connected: isPlayConnected(),
      serviceAccount: account?.client_email ?? null,
      installsTotal: playKeys.reduce((n, k) => n + playDay.get(k)!.installs, 0),
      installsLast7Days: sumPlay("installs", weekAgoKey),
      uninstallsLast7Days: sumPlay("uninstalls", weekAgoKey),
      uninstallsLast30Days: sumPlay("uninstalls", monthAgoKey),
      activeInstalls: latestPlay ? playDay.get(latestPlay)!.active : null,
      latestDay: latestPlay,
      updatedAt: play.reduce<Date | null>((m, r) => (!m || r.fetchedAt > m ? r.fetchedAt : m), null)?.toISOString() ?? null,
    },
    series,
  };
}
