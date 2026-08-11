/**
 * V5: comments and reports, including the distinct-reporter auto-unpublish threshold.
 * Runs against the real deployment. Requires STAFF_TOKEN.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const CLIP = process.env.CLIP ?? "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/test-clip.mp4";
const STAFF_TOKEN = process.env.STAFF_TOKEN;
const THRESHOLD = 5;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function register(tag) {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const body = {
    username: `sc_${tag}_${stamp}`,
    email: `sc_${tag}_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34", birthDate: "1995-06-15",
  };
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { token: json.accessToken, user: json.user };
}

async function uploadApproved(token) {
  const clip = readFileSync(CLIP);
  const form = new FormData();
  form.append("caption", "social verification");
  form.append("file", new Blob([clip], { type: "video/mp4" }), "clip.mp4");
  const res = await fetch(`${BASE}/api/videos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const created = await res.json();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = await (await fetch(`${BASE}/api/videos/mine`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const mine = list.find((v) => v.id === created.id);
    if (mine && mine.status === "PENDING_REVIEW") break;
    if (mine && mine.status === "FAILED") throw new Error(`transcode failed: ${mine.failureReason}`);
  }
  const approve = await fetch(`${BASE}/api/staff/videos/${created.id}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${STAFF_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!approve.ok) throw new Error(`approve: ${approve.status} ${await approve.text()}`);
  return created.id;
}

async function main() {
  if (!STAFF_TOKEN) throw new Error("STAFF_TOKEN required");

  const author = await register("author");
  const commenter = await register("commenter");
  const videoId = await uploadApproved(author.token);
  console.log(`approved video ${videoId}\n`);

  // --- comments ---
  const create = await fetch(`${BASE}/api/videos/${videoId}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${commenter.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "verification comment" }),
  });
  const comment = create.ok ? await create.json() : null;
  check("can post a comment (201)", create.status === 201, `got ${create.status}`);

  const list = await (await fetch(`${BASE}/api/videos/${videoId}/comments`, {
    headers: { authorization: `Bearer ${commenter.token}` },
  })).json();
  check("comment appears in the list", list.some((c) => c.id === comment?.id));

  const empty = await fetch(`${BASE}/api/videos/${videoId}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${commenter.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "   " }),
  });
  check("empty comment rejected (400)", empty.status === 400, `got ${empty.status}`);

  const feed = await (await fetch(`${BASE}/api/feed`, {
    headers: { authorization: `Bearer ${commenter.token}` },
  })).json();
  const inFeed = feed.videos.find((v) => v.id === videoId);
  check("commentCount incremented on the video", inFeed?.commentCount === 1,
    `commentCount=${inFeed?.commentCount}`);

  // a third party must not be able to delete someone else's comment
  const stranger = await register("stranger");
  const badDelete = await fetch(`${BASE}/api/videos/comments/${comment.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${stranger.token}` },
  });
  check("stranger cannot delete another user's comment (403)", badDelete.status === 403,
    `got ${badDelete.status}`);

  // the video's uploader can moderate replies on their own video
  const authorDelete = await fetch(`${BASE}/api/videos/comments/${comment.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${author.token}` },
  });
  check("video author can delete a comment on their video", authorDelete.ok, `got ${authorDelete.status}`);

  const afterDelete = await (await fetch(`${BASE}/api/feed`, {
    headers: { authorization: `Bearer ${commenter.token}` },
  })).json();
  check("commentCount decremented after delete",
    afterDelete.videos.find((v) => v.id === videoId)?.commentCount === 0,
    `commentCount=${afterDelete.videos.find((v) => v.id === videoId)?.commentCount}`);

  // --- reports ---
  const r1 = await fetch(`${BASE}/api/videos/${videoId}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${commenter.token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "SPAM", details: "verification report" }),
  });
  check("can report a video (201)", r1.status === 201, `got ${r1.status}`);

  const dupe = await fetch(`${BASE}/api/videos/${videoId}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${commenter.token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "SPAM" }),
  });
  check("same user cannot report twice (409)", dupe.status === 409, `got ${dupe.status}`);

  const badReason = await fetch(`${BASE}/api/videos/${videoId}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${stranger.token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: "NOT_A_REAL_REASON" }),
  });
  check("invalid report reason rejected (400)", badReason.status === 400, `got ${badReason.status}`);

  // one report must NOT unpublish (heckler's veto guard)
  const afterOne = await (await fetch(`${BASE}/api/feed`, {
    headers: { authorization: `Bearer ${stranger.token}` },
  })).json();
  check("a single report does NOT unpublish the video",
    afterOne.videos.some((v) => v.id === videoId));

  // --- threshold: distinct reporters pull it back to review ---
  // one already reported; add until the threshold is met
  for (let i = 0; i < THRESHOLD - 1; i++) {
    const reporter = await register(`rep${i}`);
    const res = await fetch(`${BASE}/api/videos/${videoId}/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${reporter.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "HARASSMENT" }),
    });
    if (res.status !== 201) console.log(`  (reporter ${i} got ${res.status})`);
  }

  const afterThreshold = await (await fetch(`${BASE}/api/feed`, {
    headers: { authorization: `Bearer ${stranger.token}` },
  })).json();
  check(`${THRESHOLD} distinct reporters unpublishes the video`,
    !afterThreshold.videos.some((v) => v.id === videoId));

  const staffQueue = await (await fetch(`${BASE}/api/staff/videos?status=PENDING_REVIEW`, {
    headers: { authorization: `Bearer ${STAFF_TOKEN}` },
  })).json();
  check("auto-unpublished video returns to the staff queue",
    staffQueue.some((v) => v.id === videoId));

  const authorSees = await (await fetch(`${BASE}/api/videos/mine`, {
    headers: { authorization: `Bearer ${author.token}` },
  })).json();
  const mine = authorSees.find((v) => v.id === videoId);
  check("uploader sees why it was pulled",
    mine?.status === "PENDING_REVIEW" && /report/i.test(mine?.rejectionReason ?? ""),
    `status=${mine?.status} reason=${mine?.rejectionReason}`);

  // commenting on a non-public video must fail
  const commentOnPending = await fetch(`${BASE}/api/videos/${videoId}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${stranger.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: "should not work" }),
  });
  check("cannot comment on an unpublished video (404)", commentOnPending.status === 404,
    `got ${commentOnPending.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exitCode = 1;
});
