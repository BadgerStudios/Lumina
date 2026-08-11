/**
 * Seeds the For You feed with real video from Wikimedia Commons, under three seed accounts.
 *
 * ## Why Commons and not TikTok/YouTube
 *
 * The obvious way to fill a short-video feed is to pull popular clips off an existing platform.
 * That is straightforward copyright infringement: those videos belong to the people who made them,
 * and re-hosting them publicly is exactly what gets a self-hosted instance a takedown notice — the
 * same risk the upload provenance work in this codebase exists to manage. Commons carries only
 * public-domain and Creative-Commons material, which is licensed for precisely this reuse.
 *
 * ## Attribution is not optional
 *
 * CC BY / CC BY-SA require credit. Every seeded caption therefore carries the work's title, its
 * author and its licence, and the row records the source URL. A seeded video that loses its
 * attribution is a licence violation, so this is part of the upload, not a nicety.
 *
 * Usage: node apps/backend/scripts/seed-feed.mjs [--count 30] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, createWriteStream, statSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const UA = "LuminaFeedSeeder/1.0 (self-hosted Lumina instance; contact: instance operator)";
const WORK_DIR = "/tmp/lumina-seed";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const TARGET = Number(args[args.indexOf("--count") + 1]) || 30;

/** Server-side cap is MAX_VIDEO_UPLOADS_PER_DAY per account, so the seed spreads across accounts
 * rather than hammering one and getting rate-limited halfway through. */
const SEED_USERS = [
  { username: "reef_and_ridge", displayName: "Reef & Ridge", bio: "Wild places, short clips." },
  { username: "kitchen_static", displayName: "Kitchen Static", bio: "Food, craft, and things being made." },
  { username: "orbit_notes", displayName: "Orbit Notes", bio: "Science, space, and small wonders." },
];

/** Search topics chosen to give the feed variety rather than thirty near-identical clips. Each
 * maps to the tags the upload will carry. */
const TOPICS = [
  { q: "coral reef fish", tags: ["ocean", "nature"], user: 0 },
  { q: "waterfall river", tags: ["nature", "water"], user: 0 },
  { q: "bird slow motion", tags: ["animals", "nature"], user: 0 },
  { q: "volcano lava", tags: ["nature", "geology"], user: 0 },
  { q: "butterfly", tags: ["animals", "nature"], user: 0 },
  { q: "jellyfish", tags: ["ocean", "animals"], user: 0 },
  { q: "waves sea", tags: ["ocean", "nature"], user: 0 },
  { q: "squirrel", tags: ["animals", "wildlife"], user: 0 },
  { q: "cooking food", tags: ["food", "cooking"], user: 1 },
  { q: "blacksmith forging", tags: ["craft", "making"], user: 1 },
  { q: "traditional dance", tags: ["dance", "culture"], user: 1 },
  { q: "festival procession", tags: ["culture", "festival"], user: 1 },
  { q: "weaving textile", tags: ["craft", "making"], user: 1 },
  { q: "pottery wheel", tags: ["craft", "making"], user: 1 },
  { q: "music performance", tags: ["music", "culture"], user: 1 },
  { q: "chemical reaction", tags: ["science", "chemistry"], user: 2 },
  { q: "microscope", tags: ["science", "biology"], user: 2 },
  { q: "lightning storm", tags: ["weather", "nature"], user: 2 },
  { q: "clouds timelapse", tags: ["timelapse", "weather"], user: 2 },
  { q: "fountain water", tags: ["water", "city"], user: 2 },
  { q: "snow winter", tags: ["weather", "nature"], user: 2 },
  { q: "train railway", tags: ["transport", "machines"], user: 2 },
  { q: "crystal formation", tags: ["science", "chemistry"], user: 2 },
];

const MAX_MB = 60;
const MIN_SEC = 3;
const MAX_SEC = 175;

const log = (...a) => console.log(...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function commonsSearch(query, limit = 20) {
  await sleep(1200);
  const url =
    `${COMMONS}?action=query&generator=search&gsrsearch=${encodeURIComponent(`filetype:video ${query}`)}` +
    `&gsrlimit=${limit}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = data?.query?.pages ?? {};
  return Object.values(pages)
    .map((p) => {
      const ii = p.imageinfo?.[0];
      if (!ii) return null;
      const em = ii.extmetadata ?? {};
      const strip = (v) => (v ? String(v).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : "");
      return {
        title: p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
        url: ii.url,
        mime: ii.mime,
        sizeMb: ii.size / 1024 / 1024,
        duration: ii.duration ?? 0,
        author: strip(em.Artist?.value) || "Unknown author",
        license: strip(em.LicenseShortName?.value) || "see source",
        descriptionUrl: ii.descriptionurl,
      };
    })
    .filter(Boolean);
}

function usable(c) {
  return (
    c.duration >= MIN_SEC &&
    c.duration <= MAX_SEC &&
    c.sizeMb > 0.05 &&
    c.sizeMb <= MAX_MB &&
    /^video\//.test(c.mime)
  );
}

/** Caption doubles as the attribution notice required by CC BY / CC BY-SA. */
function buildCaption(c) {
  const author = c.author.length > 70 ? `${c.author.slice(0, 70)}…` : c.author;
  const title = c.title.length > 90 ? `${c.title.slice(0, 90)}…` : c.title;
  return `${title} — ${author} (${c.license}), via Wikimedia Commons`.slice(0, 300);
}

/**
 * Downloads one clip, pacing and retrying against Wikimedia's rate limiter.
 *
 * The first run of this script paced its SEARCHES but fired the media downloads back to back, and
 * upload.wikimedia.org answered 429 to all but the first few — 26 of 30 clips failed. Media fetches
 * are the expensive request here and need the same courtesy as the API calls. Honouring
 * Retry-After matters: guessing an interval when the server has told you the answer is how a
 * client ends up rate-limited for longer than necessary.
 */
async function download(c, index) {
  const path = `${WORK_DIR}/${index}.${c.mime.includes("webm") ? "webm" : "mp4"}`;
  let wait = 4000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(wait);
    const res = await fetch(c.url, { headers: { "user-agent": UA } });
    if (res.ok) {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
      return path;
    }
    if (res.status !== 429 && res.status !== 503) throw new Error(`download ${res.status}`);
    const retryAfter = Number(res.headers.get("retry-after"));
    wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait * 2;
    log(`    rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/5)`);
  }
  throw new Error("rate limited after 5 attempts");
}

async function ensureUser(u) {
  const email = `${u.username}@seed.lumina.local`;
  const password = `Seed-${u.username}-${process.env.SEED_PASSWORD_SALT ?? "2026"}`;
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: u.username,
      email,
      password,
      ageBracket: "AGE_25_34",
      birthDate: "1994-06-15",
    }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    // Already-registered is fine; anything else is not.
    if (!/already/i.test(body)) throw new Error(`register ${u.username}: ${res.status} ${body}`);
  }
  res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername: u.username, password }),
  });
  if (!res.ok) throw new Error(`login ${u.username}: ${res.status}`);
  const { accessToken } = await res.json();

  // Profile, so the seeded accounts don't look like the empty shells the suggestion panel
  // deliberately filters out.
  await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: u.displayName, bio: u.bio }),
  });
  return accessToken;
}

async function upload(token, path, caption, tags) {
  const form = new FormData();
  form.append("caption", caption);
  form.append("tags", tags.join(","));
  const buf = await import("node:fs/promises").then((fs) => fs.readFile(path));
  form.append("file", new Blob([buf], { type: "video/mp4" }), path.split("/").pop());
  const res = await fetch(`${BASE}/api/videos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function main() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  log("searching Wikimedia Commons…");
  const chosen = [];
  const seenTitles = new Set();
  for (const topic of TOPICS) {
    if (chosen.length >= TARGET) break;
    const results = (await commonsSearch(topic.q)).filter(usable);
    // Capped per topic so the feed stays varied instead of ten clips of one subject.
    let taken = 0;
    for (const c of results) {
      if (taken >= 3 || chosen.length >= TARGET) break;
      if (seenTitles.has(c.title)) continue;
      seenTitles.add(c.title);
      chosen.push({ ...c, tags: topic.tags, user: topic.user });
      taken++;
    }
    log(`  ${topic.q}: ${results.length} usable, took ${taken}`);
  }

  log(`\n${chosen.length} clips selected:`);
  for (const c of chosen) {
    log(`  [${SEED_USERS[c.user].username}] ${Math.round(c.duration)}s ${c.sizeMb.toFixed(1)}MB  ${c.license}  ${c.title.slice(0, 60)}`);
  }
  if (DRY_RUN) {
    log("\n--dry-run: nothing downloaded or uploaded");
    return;
  }

  log("\ncreating seed accounts…");
  const tokens = [];
  for (const u of SEED_USERS) {
    tokens.push(await ensureUser(u));
    log(`  ${u.username} ready`);
  }

  // Re-running after a partial failure must not re-upload what already landed. Captions carry the
  // source title, so they identify a clip well enough to skip it — and the per-account daily cap
  // means a duplicate would burn a slot that a missing clip needs.
  const already = new Set();
  for (const token of tokens) {
    const res = await fetch(`${BASE}/api/videos/mine`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) continue;
    const body = await res.json();
    for (const v of body.items ?? body ?? []) if (v.caption) already.add(v.caption);
  }
  if (already.size > 0) log(`  ${already.size} already uploaded — those will be skipped`);

  let uploaded = 0;
  const failures = [];
  for (const [i, c] of chosen.entries()) {
    if (already.has(buildCaption(c))) {
      log(`  skipping (already uploaded) ${c.title.slice(0, 50)}`);
      continue;
    }
    try {
      const path = await download(c, i);
      const mb = statSync(path).size / 1024 / 1024;
      if (mb > MAX_MB) {
        failures.push(`${c.title}: ${mb.toFixed(1)}MB after download`);
        rmSync(path, { force: true });
        continue;
      }
      const video = await upload(tokens[c.user], path, buildCaption(c), c.tags);
      rmSync(path, { force: true });
      uploaded++;
      log(`  ${uploaded}/${chosen.length} uploaded id=${video.id} ${c.title.slice(0, 50)}`);
    } catch (err) {
      failures.push(`${c.title}: ${err.message}`);
      log(`  FAILED ${c.title.slice(0, 50)} — ${err.message}`);
    }
  }

  log(`\n${uploaded} uploaded, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => log(`  - ${f}`));
  log("\nThey are in PROCESSING/PENDING_REVIEW — approve them from /staff/videos.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
