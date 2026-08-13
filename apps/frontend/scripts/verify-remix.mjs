// Verifies stitch and duet against the REAL deployment, all the way through the worker.
//
// The assertion that actually matters is that the *composed* file is right — dimensions, duration,
// and that both halves are really in it. Everything else (a 201 from the upload route, a row with
// derivativeType set) can be true while ffmpeg produced a black rectangle, and that failure mode is
// invisible from the API. So the composed playback file is downloaded and probed.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
const rand = Date.now();
const PASSWORD = "verify-remix-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-remix-"));

/** A short, cheap, unmistakable clip: solid colour plus a tone, so the composed output can be told
 * apart from black-and-silence by measurement rather than by eye. */
function makeClip(name, color, seconds) {
  const file = path.join(tmp, name);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=540x960:d=${seconds}:r=30`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    file,
  ]);
  return file;
}

function probe(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_entries", "format=duration:stream=width,height,codec_type",
    file,
  ], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  const v = parsed.streams.find((s) => s.codec_type === "video");
  return {
    durationSec: Number(parsed.format.duration),
    width: v?.width,
    height: v?.height,
    hasAudio: parsed.streams.some((s) => s.codec_type === "audio"),
  };
}

async function mkUser(username) {
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername: username, password: PASSWORD }),
  });
  return (await res.json()).accessToken;
}

async function uploadRemix(token, file, fields) {
  const form = new FormData();
  // Field order matters: the route reads these off `part.fields` while streaming the file, so a
  // field appended after the file is simply not there yet when it looks.
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append("file", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  const res = await fetch(`${BASE}/api/videos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Polls the uploader's own list until the worker has finished with it. */
async function waitProcessed(token, videoId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/videos/mine`, { headers: { authorization: `Bearer ${token}` } });
    const mine = await res.json();
    const found = mine.find((v) => v.id === videoId);
    if (found && found.status !== "PROCESSING") return found;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function main() {
  const remixer = `vrx_${rand}`;
  const created = [];
  let token;

  try {
    token = await mkUser(remixer);

    // A real, already-approved video to remix. Using an existing one rather than uploading a source
    // keeps this inside the 12-uploads/hour brake, which is a real limit and not one to weaken for
    // a test's convenience.
    const feed = await (await fetch(`${BASE}/api/feed?limit=10`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const source = feed.videos.find((v) => v.durationMs && v.durationMs > 6000 && v.allowDuet && v.allowStitch);
    if (!source) return bad("no approved, remixable video in the feed to test against");
    ok(`found a source video to remix (${source.durationMs}ms, @${source.author?.username})`);

    const beforeCount = Number(sql(`select "derivativeCount" from "Video" where id = ${source.id};`));

    // ---- adversarial cases first: all of these must be refused BEFORE any bytes are stored ----
    const clip = makeClip("own.mp4", "blue", 4);

    // The VPN/Tor risk gate (modules/risk) blocks uploads from NEW accounts on datacenter IPs —
    // which is exactly what this suite's fresh account on a hosted runner is. That's the fraud
    // control working, not a remix bug, and it fires before every remix-specific check this suite
    // exists to make. Announce and stop rather than reporting the gate as four failures; never
    // weaken the gate itself for a test's convenience.
    const gateProbe = await uploadRemix(token, clip, { duetOf: "999999999" });
    if (gateProbe.status === 403 && /VPN or Tor/i.test(gateProbe.body?.error ?? "")) {
      console.log("SKIP: the new-account VPN/Tor upload gate is active for this runner's IP — remix checks need a residential IP or an aged account.");
      return; // the finally block still cleans up the test account
    }

    const missing = gateProbe.status === 404 ? gateProbe : await uploadRemix(token, clip, { duetOf: "999999999" });
    if (missing.status === 404) ok("a duet of a nonexistent video is refused (404)");
    else bad(`duet of a nonexistent id returned ${missing.status}`);

    const tooLong = await uploadRemix(token, clip, { stitchOf: source.id, stitchStartMs: 0, stitchEndMs: 9000 });
    if (tooLong.status === 400) ok(`an over-long stitch segment is refused: "${tooLong.body?.error}"`);
    else bad(`a 9s stitch segment returned ${tooLong.status}`);

    const both = await uploadRemix(token, clip, { duetOf: source.id, stitchOf: source.id });
    if (both.status === 400) ok("a request claiming to be both a stitch and a duet is refused");
    else bad(`stitch+duet at once returned ${both.status}`);

    const notMine = await fetch(`${BASE}/api/videos/${source.id}/remix-settings`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ allowDuet: false }),
    });
    if (notMine.status === 404) ok("you cannot change remix settings on someone else's video");
    else bad(`patching another user's remix settings returned ${notMine.status}`);

    // ---- the duet ----------------------------------------------------------------------------
    const duet = await uploadRemix(token, clip, { duetOf: source.id, caption: "verify duet" });
    if (duet.status !== 201) return bad(`duet upload failed: ${duet.status} ${JSON.stringify(duet.body)}`);
    created.push(duet.body.id);

    const duetDone = await waitProcessed(token, duet.body.id);
    if (!duetDone) return bad("the duet never finished processing");
    if (duetDone.status === "PENDING_REVIEW") ok("the duet composed successfully and is awaiting review");
    else return bad(`the duet ended as ${duetDone.status}: ${duetDone.failureReason ?? ""}`);

    if (duetDone.derivativeType === "DUET" && duetDone.sourceVideo?.id === source.id) {
      ok(`the duet credits @${duetDone.sourceVideo.author?.username} as the source`);
    } else {
      bad(`attribution missing: type=${duetDone.derivativeType} source=${duetDone.sourceVideo?.id}`);
    }

    // Download and probe what was actually produced. This is what separates "the row looks right"
    // from "the video is right".
    const duetFile = path.join(tmp, "duet-out.mp4");
    const media = await fetch(`${BASE}/api/videos/${duetDone.id}/playback`, {
      headers: { authorization: `Bearer ${token}` },
    });
    fs.writeFileSync(duetFile, Buffer.from(await media.arrayBuffer()));
    const dp = probe(duetFile);

    if (dp.width === 1080 && dp.height === 1920) ok(`the duet renders on the portrait canvas (${dp.width}x${dp.height})`);
    else bad(`the duet is ${dp.width}x${dp.height}; expected 1080x1920`);

    // The clip is 4s and the source is longer, so "ends with the shorter one" means ~4s. A duet
    // that came out the length of the source would mean the creator's half froze for the rest.
    if (Math.abs(dp.durationSec - 4) < 1.0) ok(`the duet ends with the shorter clip (${dp.durationSec.toFixed(1)}s)`);
    else bad(`the duet is ${dp.durationSec.toFixed(1)}s; expected about 4s`);

    if (dp.hasAudio) ok("the duet carries a mixed audio track");
    else bad("the duet has no audio stream — amix did not run");

    // Two halves, not one video padded out. Sampled from the composed frame: the left column comes
    // from the source and the right is the solid blue test clip, so they must differ.
    const left = sampleColor(duetFile, "270:960:0:480");
    const right = sampleColor(duetFile, "270:960:810:480");
    if (right.b > 100 && right.b > right.r + 40) ok("the creator's own clip occupies the right half");
    else bad(`the right half isn't the recorded clip (rgb ${right.r},${right.g},${right.b})`);
    if (Math.abs(left.r - right.r) + Math.abs(left.g - right.g) + Math.abs(left.b - right.b) > 40) {
      ok("the two halves show different footage");
    } else {
      bad("both halves look identical — the source side may not have been composited");
    }

    const afterCount = Number(sql(`select "derivativeCount" from "Video" where id = ${source.id};`));
    if (afterCount === beforeCount + 1) ok(`the source's remix count went ${beforeCount} -> ${afterCount}`);
    else bad(`the source's remix count is ${afterCount}, expected ${beforeCount + 1}`);

    // ---- the stitch --------------------------------------------------------------------------
    const stitch = await uploadRemix(token, clip, {
      stitchOf: source.id, stitchStartMs: 1000, stitchEndMs: 4000, caption: "verify stitch",
    });
    if (stitch.status !== 201) return bad(`stitch upload failed: ${stitch.status} ${JSON.stringify(stitch.body)}`);
    created.push(stitch.body.id);

    const stitchDone = await waitProcessed(token, stitch.body.id);
    if (!stitchDone) return bad("the stitch never finished processing");
    if (stitchDone.status === "PENDING_REVIEW") ok("the stitch composed successfully and is awaiting review");
    else return bad(`the stitch ended as ${stitchDone.status}: ${stitchDone.failureReason ?? ""}`);

    const stitchFile = path.join(tmp, "stitch-out.mp4");
    const smedia = await fetch(`${BASE}/api/videos/${stitchDone.id}/playback`, {
      headers: { authorization: `Bearer ${token}` },
    });
    fs.writeFileSync(stitchFile, Buffer.from(await smedia.arrayBuffer()));
    const sp = probe(stitchFile);

    // 3s quoted + 4s of the creator's own clip. A concat that silently dropped one segment shows up
    // here as a duration of roughly one part instead of both.
    if (Math.abs(sp.durationSec - 7) < 1.0) ok(`the stitch is both parts end to end (${sp.durationSec.toFixed(1)}s)`);
    else bad(`the stitch is ${sp.durationSec.toFixed(1)}s; expected about 7s (3s quoted + 4s own)`);

    // The quoted part comes first, the creator's clip second — the defining property of a stitch.
    const early = sampleColorAt(stitchFile, 1.0);
    const late = sampleColorAt(stitchFile, 5.0);
    if (late.b > 100 && late.b > late.r + 40) ok("the creator's clip plays in the second half");
    else bad(`the second half isn't the recorded clip (rgb ${late.r},${late.g},${late.b})`);
    if (!(early.b > 100 && early.b > early.r + 40)) ok("the quoted source plays first");
    else bad("the stitch starts with the creator's own clip — the quote is missing or out of order");

    // ---- chains are refused --------------------------------------------------------------------
    // Approving via SQL rather than through the staff API: this test is about the remix rule, and
    // minting a staff account to prove it would test the wrong thing.
    sql(`update "Video" set status = 'APPROVED' where id = ${stitchDone.id};`);
    const chained = await uploadRemix(token, clip, { duetOf: stitchDone.id });
    if (chained.status === 400) ok(`a remix of a remix is refused: "${chained.body?.error}"`);
    else bad(`duetting a derivative returned ${chained.status}`);
  } catch (e) {
    bad(`remix flow: ${String(e).split("\n")[0]}`);
  } finally {
    // Delete the rows first, then the exact files those rows named — never a glob in a shared
    // media directory.
    for (const id of created) {
      const keys = sql(
        `select coalesce("playbackKey",''), coalesce("thumbnailKey",''), coalesce("sourceKey",'') from "Video" where id = ${id};`,
      );
      const [playback, thumb, src] = keys.split("|");
      sql(`delete from "Video" where id = ${id};`);
      for (const [dir, name] of [["playback", playback], ["thumbs", thumb], ["source", src]]) {
        if (!name) continue;
        try {
          execFileSync("docker", ["compose", "exec", "-T", "worker", "rm", "-f", `/data/uploads/videos/${dir}/${name}`], { cwd: REPO });
        } catch { /* already gone */ }
      }
    }
    sql(`delete from "User" where username = '${remixer}';`);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`cleaned up ${remixer} and ${created.length} video(s)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/** Average RGB of a crop region (w:h:x:y) sampled a second into the file. */
function sampleColor(file, crop) {
  return parseSignalStats(["-ss", "1", "-i", file, "-vf", `crop=${crop},signalstats,metadata=print`, "-frames:v", "1"]);
}

/** Average RGB of the whole frame at a given timestamp. */
function sampleColorAt(file, seconds) {
  return parseSignalStats(["-ss", String(seconds), "-i", file, "-vf", "signalstats,metadata=print", "-frames:v", "1"]);
}

function parseSignalStats(args) {
  // signalstats reports YUV averages; converting back to RGB is enough to distinguish "solid blue
  // test card" from "anything else", which is all these assertions need.
  //
  // spawnSync, not execFileSync: signalstats logs its per-frame metadata to STDERR, and
  // execFileSync returns stdout — which for `-f null -` is empty. Reading the wrong stream made
  // every sample come back as pure black and turned three real assertions into noise (and one of
  // them into a false pass, which is worse).
  const proc = spawnSync("ffmpeg", ["-v", "info", "-nostdin", ...args, "-f", "null", "-"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = proc.stderr ?? "";
  // signalstats only *sets* frame metadata; it doesn't log it. `metadata=print` is what actually
  // emits `lavfi.signalstats.YAVG=...` — without it the stream is silent and every sample reads as
  // pure black, which is a plausible-looking wrong answer rather than an obvious failure.
  const y = Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(out)?.[1] ?? 0);
  const u = Number(/lavfi\.signalstats\.UAVG=([\d.]+)/.exec(out)?.[1] ?? 128);
  const v = Number(/lavfi\.signalstats\.VAVG=([\d.]+)/.exec(out)?.[1] ?? 128);
  if (!/lavfi\.signalstats\.YAVG=/.test(out)) throw new Error("could not sample frame colour");
  const c = y - 16, d = u - 128, e = v - 128;
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return {
    r: clamp(1.164 * c + 1.596 * e),
    g: clamp(1.164 * c - 0.392 * d - 0.813 * e),
    b: clamp(1.164 * c + 2.017 * d),
  };
}

main();
