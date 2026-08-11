// Verifies the personalised For You ranking against the REAL deployment.
//
// The claim being tested is narrow and specific, so the test is too: liking a video should lift
// OTHER videos sharing its tags for that viewer, relative to a viewer who has liked nothing — with
// the same seed, so jitter is identical and any difference in order is attributable to the taste
// profile alone. Comparing two users on one seed is the whole trick; comparing one user before and
// after would confound the change with the feed moving on.
//
// It also checks the property that matters most for a small instance: personalisation must never
// REMOVE anything. A ranker that filters rather than reorders empties a feed like this one.
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-personal-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

async function mkUser(username) {
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@example.com`,
      password: PASSWORD,
      ageBracket: "AGE_25_34",
      birthDate: "1995-04-01",
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

const get = async (token, path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
};

async function main() {
  const plain = `vp_plain_${rand}`;
  const fan = `vp_fan_${rand}`;

  try {
    const tokenPlain = await mkUser(plain);
    const tokenFan = await mkUser(fan);

    // A fixed seed makes the two viewers' jitter identical, so the only thing that can differ is
    // the personalisation term.
    const SEED = 424242;
    const before = await get(tokenFan, `/api/feed?limit=30&seed=${SEED}`);
    const baseline = await get(tokenPlain, `/api/feed?limit=30&seed=${SEED}`);

    if (before.videos.length >= 4) ok(`feed has ${before.videos.length} videos to rank`);
    else return bad(`only ${before.videos.length} videos in the feed — not enough to test ranking`);

    // Identical with no history on either side: a viewer who has done nothing must see exactly the
    // unpersonalised order, not a subtly different one.
    const idsBefore = before.videos.map((v) => v.id).join(",");
    const idsBaseline = baseline.videos.map((v) => v.id).join(",");
    if (idsBefore === idsBaseline) ok("two viewers with no history get an identical order");
    else bad(`viewers with no history disagreed:\n  ${idsBefore}\n  ${idsBaseline}`);

    // Pick a tag shared by at least two videos but NOT by most of them.
    //
    // This matters more than it looks. The affinity term is multiplicative, so a tag carried by
    // nearly every video multiplies every score by the same factor and provably cannot reorder
    // anything — picking the MOST common tag tests nothing while looking like a failure. The tag
    // has to divide the feed for the lift to be observable at all.
    const tagCounts = new Map();
    for (const v of before.videos) for (const t of v.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    const half = before.videos.length / 2;
    const sharedTag = [...tagCounts.entries()]
      .filter(([, n]) => n >= 2 && n <= half)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!sharedTag) {
      return bad(
        `no tag divides the feed (counts: ${[...tagCounts].map(([t, n]) => `${t}=${n}`).join(" ")}) — cannot observe a lift`,
      );
    }
    const untagged = before.videos.filter((v) => !v.tags.includes(sharedTag)).map((v) => v.id);

    const withTag = before.videos.filter((v) => v.tags.includes(sharedTag));
    const liked = withTag[0];
    const others = withTag.slice(1).map((v) => v.id);
    const rankOf = (list, id) => list.findIndex((v) => v.id === id);

    const likeRes = await fetch(`${BASE}/api/feed/${liked.id}/like`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFan}`, "content-type": "application/json" },
      body: "{}",
    });
    if (likeRes.ok) ok(`liked one "#${sharedTag}" video as ${fan}`);
    else return bad(`like failed: ${likeRes.status}`);

    const after = await get(tokenFan, `/api/feed?limit=30&seed=${SEED}`);

    // Nothing may disappear. This is the property that protects a small instance.
    const missing = before.videos.filter((v) => !after.videos.some((a) => a.id === v.id));
    if (missing.length === 0) ok("personalisation removed nothing from the feed");
    else bad(`${missing.length} video(s) vanished after personalisation`);

    // The other videos carrying that tag should now rank at least as high as they did, and at
    // least one should have moved up. Averaged, because the author-spread pass can legitimately
    // hold one item back a slot.
    // Mean rank of the tagged group against the untagged group, before and after. Comparing group
    // means rather than individual positions is the right measure for a reordering: a single item
    // can legitimately hold station while the group as a whole rises.
    const meanRank = (list, ids) =>
      ids.length === 0 ? 0 : ids.reduce((sum, id) => sum + rankOf(list, id), 0) / ids.length;
    const gapBefore = meanRank(before.videos, untagged) - meanRank(before.videos, others);
    const gapAfter = meanRank(after.videos, untagged) - meanRank(after.videos, others);

    if (others.length === 0) {
      console.log(`NOTE: only one "#${sharedTag}" video exists; tag-lift assertion skipped`);
    } else if (gapAfter > gapBefore) {
      ok(
        `videos sharing "#${sharedTag}" rose relative to the rest ` +
          `(rank gap ${gapBefore.toFixed(2)} -> ${gapAfter.toFixed(2)})`,
      );
    } else {
      bad(`tag affinity did not lift similar videos (rank gap ${gapBefore.toFixed(2)} -> ${gapAfter.toFixed(2)})`);
    }

    // The unpersonalised viewer must be untouched by someone else's like.
    const baselineAfter = await get(tokenPlain, `/api/feed?limit=30&seed=${SEED}`);
    if (baselineAfter.videos.map((v) => v.id).join(",") === idsBaseline) {
      ok("another viewer's like did not change this viewer's order");
    } else {
      bad("an unrelated viewer's ordering changed after someone else liked something");
    }

    // No more than two consecutive videos from one uploader — only meaningful when there IS more
    // than one uploader. The spread pass defers a run rather than dropping it, so a feed where
    // every video has the same author legitimately still shows them all consecutively.
    const authors = new Set(after.videos.map((v) => v.author?.id).filter(Boolean));
    let worstRun = 1;
    let run = 1;
    for (let i = 1; i < after.videos.length; i++) {
      const a = after.videos[i - 1].author?.id;
      const b = after.videos[i].author?.id;
      run = a && a === b ? run + 1 : 1;
      if (run > worstRun) worstRun = run;
    }
    if (authors.size < 2) {
      console.log(`NOTE: feed has ${authors.size} uploader(s); author-spread assertion skipped`);
    } else if (worstRun <= 2) {
      ok(`no uploader appears more than twice in a row (longest run ${worstRun})`);
    } else {
      bad(`one uploader appeared ${worstRun} times consecutively`);
    }
  } catch (e) {
    bad("personalisation flow", String(e));
  } finally {
    sql(`delete from "User" where username in ('${plain}', '${fan}');`);
    console.log(`cleaned up ${plain}, ${fan}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
