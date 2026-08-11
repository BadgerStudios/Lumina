/**
 * Phase 2: tags, upload provenance, and the report-ticket workflow.
 * Requires MASTER_TOKEN (master is also staff, so one token covers both surfaces).
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const CLIP = process.env.CLIP ?? "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/test-clip.mp4";
const MASTER_TOKEN = process.env.MASTER_TOKEN;

const results = [];
const check = (n, p, d = "") => {
  results.push({ n, p, d });
  console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
};

async function req(path, opts = {}, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function register(tag) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const body = {
    username: `t2_${tag}_${stamp}`.slice(0, 30),
    email: `t2_${tag}_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34",
    birthDate: "1995-06-15",
  };
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`register ${tag}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { token: json.accessToken, user: json.user, creds: body };
}

/** Uploads with tags and waits for the worker, then approves so it reaches the feed. */
async function uploadWithTags(token, tags, caption) {
  const form = new FormData();
  form.append("caption", caption);
  form.append("tags", tags.join(","));
  form.append("file", new Blob([readFileSync(CLIP)], { type: "video/mp4" }), "clip.mp4");

  const res = await fetch(`${BASE}/api/videos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
  const created = await res.json();

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = await (await fetch(`${BASE}/api/videos/mine`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const mine = list.find((v) => v.id === created.id);
    if (mine?.status === "PENDING_REVIEW") break;
    if (mine?.status === "FAILED") throw new Error(`transcode failed: ${mine.failureReason}`);
  }
  await req(`/staff/videos/${created.id}/approve`, { method: "POST", body: "{}" }, MASTER_TOKEN);
  return created.id;
}

async function main() {
  if (!MASTER_TOKEN) throw new Error("MASTER_TOKEN required");

  const author = await register("author");
  const reporter = await register("reporter");

  // ---------- tags ----------
  // Three spellings of one word must collapse to a single tag; if they don't, the tag index
  // fragments and search stops finding anything.
  const videoId = await uploadWithTags(author.token, ["Gaming", "gaming", " GAMING ", "speed-run"], "tag test");
  check("upload with tags succeeds", Boolean(videoId), `video ${videoId}`);

  const tagSearch = await req("/lookup/tags?q=gam", {}, author.token);
  const gaming = tagSearch.body?.tags?.filter((t) => t.name === "gaming") ?? [];
  check("tag typeahead finds the tag", gaming.length > 0, `${tagSearch.body?.tags?.length} results`);
  check("case and whitespace variants collapse to ONE tag", gaming.length === 1,
    `${gaming.length} rows named "gaming"`);

  const suggest = await req("/lookup/tags", {}, author.token);
  check("empty tag query returns suggestions", suggest.body?.suggested === true,
    `${suggest.body?.tags?.length} suggested`);

  const feedTagged = await req("/feed?tag=gaming", {}, reporter.token);
  check("feed filters by tag", feedTagged.body?.videos?.some((v) => v.id === videoId),
    `${feedTagged.body?.videos?.length} in tag feed`);

  const feedOther = await req("/feed?tag=zzz-nonexistent", {}, reporter.token);
  check("unknown tag returns an empty feed", feedOther.body?.videos?.length === 0);

  // ---------- provenance ----------
  const prov = await req(`/master/videos/${videoId}/provenance`, {}, MASTER_TOKEN);
  check("master can read upload provenance", prov.status === 200, `got ${prov.status}`);
  check("provenance records the uploader", prov.body?.uploader?.id === author.user.id);
  check("provenance carries a content hash", typeof prov.body?.sha256 === "string" && prov.body.sha256.length === 64);
  check("provenance captured an IP", Boolean(prov.body?.ip), prov.body?.ip ? "present" : "missing");

  const provAsAuthor = await req(`/master/videos/${videoId}/provenance`, {}, author.token);
  check("ordinary user cannot read provenance (403)", provAsAuthor.status === 403, `got ${provAsAuthor.status}`);

  // Reading identifying data should itself leave a trail.
  const audit = await req("/master/audit?limit=20", {}, MASTER_TOKEN);
  check("provenance read is written to the audit log",
    audit.body?.some?.((e) => e.actionType === "PROVENANCE_VIEW" && e.targetId === String(videoId)));

  // ---------- report tickets ----------
  const filed = await req(
    `/videos/${videoId}/report`,
    { method: "POST", body: JSON.stringify({ reason: "SPAM", details: "phase 2 ticket test" }) },
    reporter.token,
  );
  check("a report can be filed", filed.status === 201, `got ${filed.status}`);

  const queue = await req("/staff/reports?status=OPEN", {}, MASTER_TOKEN);
  const ticket = queue.body?.reports?.find((r) => r.video?.id === String(videoId));
  check("report appears in the staff queue", Boolean(ticket), `${queue.body?.reports?.length} open`);
  check("ticket card carries a summary", Boolean(ticket?.reason) && ticket?.details === "phase 2 ticket test");
  check("ticket shows how many reported the same video", (ticket?.totalReportsOnVideo ?? 0) >= 1,
    `${ticket?.totalReportsOnVideo}`);

  const claim = await req(`/staff/reports/${ticket.id}/claim`, { method: "POST", body: JSON.stringify({ status: "IN_PROGRESS" }) }, MASTER_TOKEN);
  check("staff can claim a ticket", claim.status === 200, `got ${claim.status}`);
  check("claim records who took it", Boolean(claim.body?.assignedTo?.id));
  check("claim moves it to IN_PROGRESS", claim.body?.status === "IN_PROGRESS", claim.body?.status);

  const investigating = await req(`/staff/reports/${ticket.id}/claim`, { method: "POST", body: JSON.stringify({ status: "INVESTIGATING" }) }, MASTER_TOKEN);
  check("ticket can move to INVESTIGATING", investigating.body?.status === "INVESTIGATING", investigating.body?.status);

  // Another moderator must not be able to take a ticket already being worked.
  const other = await register("other");
  await req("/master/grant", { method: "POST", body: JSON.stringify({ userId: other.user.id, platformRole: "STAFF" }) }, MASTER_TOKEN);
  const steal = await req(`/staff/reports/${ticket.id}/claim`, { method: "POST", body: "{}" }, other.token);
  check("another moderator cannot steal an assigned ticket (403)", steal.status === 403, `got ${steal.status}`);

  const noNote = await req(`/staff/reports/${ticket.id}/complete`, { method: "POST", body: JSON.stringify({ outcome: "COMPLETED" }) }, MASTER_TOKEN);
  check("completing without a note is refused (400)", noNote.status === 400, `got ${noNote.status}`);

  const done = await req(
    `/staff/reports/${ticket.id}/complete`,
    { method: "POST", body: JSON.stringify({ outcome: "COMPLETED", note: "Reviewed — no action needed." }) },
    MASTER_TOKEN,
  );
  check("ticket can be completed with a note", done.status === 200, `got ${done.status}`);
  check("completion records who resolved it", Boolean(done.body?.resolvedBy?.id));

  const reclose = await req(`/staff/reports/${ticket.id}/complete`, { method: "POST", body: JSON.stringify({ outcome: "COMPLETED", note: "again" }) }, MASTER_TOKEN);
  check("a closed ticket cannot be closed twice (400)", reclose.status === 400, `got ${reclose.status}`);

  // The reporter must actually receive the outcome — a report that vanishes teaches people to stop
  // reporting.
  const mine = await req("/staff/reports/mine", {}, reporter.token);
  const theirs = mine.body?.reports?.find((r) => r.id === ticket.id);
  check("reporter sees their own report", Boolean(theirs));
  check("reporter sees the outcome", theirs?.status === "COMPLETED", theirs?.status);
  check("reporter sees the moderator's note", theirs?.resolutionNote === "Reviewed — no action needed.");

  const nosey = await req("/staff/reports", {}, reporter.token);
  check("ordinary user cannot read the staff queue (403)", nosey.status === 403, `got ${nosey.status}`);

  // ---------- rating + leaderboard ----------
  const wrongUser = await req(`/staff/reports/${ticket.id}/rate`, { method: "POST", body: JSON.stringify({ rating: 5 }) }, author.token);
  check("only the reporter can rate their report (403)", wrongUser.status === 403, `got ${wrongUser.status}`);

  const badRating = await req(`/staff/reports/${ticket.id}/rate`, { method: "POST", body: JSON.stringify({ rating: 9 }) }, reporter.token);
  check("rating outside 1-5 is refused (400)", badRating.status === 400, `got ${badRating.status}`);

  const rated = await req(`/staff/reports/${ticket.id}/rate`, { method: "POST", body: JSON.stringify({ rating: 4 }) }, reporter.token);
  check("reporter can rate a closed ticket", rated.status === 200, `got ${rated.status}`);

  const twice = await req(`/staff/reports/${ticket.id}/rate`, { method: "POST", body: JSON.stringify({ rating: 1 }) }, reporter.token);
  check("a report cannot be rated twice (400)", twice.status === 400, `got ${twice.status}`);

  const board = await req("/staff/reports/leaderboard", {}, MASTER_TOKEN);
  check("staff can read the leaderboard", board.status === 200, `got ${board.status}`);
  const me = board.body?.leaderboard?.find((e) => e.user?.id === done.body?.resolvedBy?.id);
  check("resolver appears on the leaderboard", Boolean(me));
  check("stars became points", me?.points >= 4, `points=${me?.points}`);
  check("leaderboard reports volume alongside rating", typeof me?.resolved === "number" && me?.averageRating !== undefined,
    `resolved=${me?.resolved} avg=${me?.averageRating}`);
  check("leaderboard tracks dismissals separately", typeof me?.dismissed === "number", `dismissed=${me?.dismissed}`);

  const boardAsUser = await req("/staff/reports/leaderboard", {}, reporter.token);
  check("ordinary user cannot read the leaderboard (403)", boardAsUser.status === 403, `got ${boardAsUser.status}`);

  // cleanup
  await req("/master/grant", { method: "POST", body: JSON.stringify({ userId: other.user.id, platformRole: "USER" }) }, MASTER_TOKEN);

  const failed = results.filter((r) => !r.p);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.n}${f.d ? ` (${f.d})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exitCode = 1;
});
