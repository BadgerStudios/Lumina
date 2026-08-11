// Browser verification of the three surfaces that had a complete backend and no client:
// video tags, the reporter's ticket view with its star rating, and master-only upload provenance.
//
// Every assertion is made against the live database after a real click, because all three of these
// shipped as "done" while typechecking, deploying, and doing nothing — the API existed, no UI ever
// called it. Compilation proves none of that; only the database does.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const CLIP =
  process.env.CLIP ??
  "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/test-clip.mp4";
const rand = Date.now();
const PASSWORD = "verify-tags-ui-pw-1";
const TAG_TYPED = `vtag${rand}`;
let pass = 0,
  fail = 0;

const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

function sql(query) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", query],
    { cwd: "/home/lucid/lumina", encoding: "utf8" },
  ).trim();
}

async function api(path, opts = {}) {
  return fetch(`${BASE}/api${path}`, opts);
}

async function register(username) {
  const res = await api("/auth/register", {
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
  return (await res.json()).accessToken;
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/email or username/i).fill(username);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /^(sign in|log in)$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
}

/** Waits for the transcode worker to move a video out of PROCESSING. */
async function waitForReview(videoId) {
  for (let i = 0; i < 90; i++) {
    const status = sql(`select status from "Video" where id = ${videoId};`);
    if (status === "PENDING_REVIEW") return true;
    if (status === "FAILED") throw new Error("transcode FAILED");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("video never reached PENDING_REVIEW");
}

async function main() {
  const uploaderName = `vt_up_${rand}`;
  const staffName = `vt_staff_${rand}`;
  const reporterName = `vt_rep_${rand}`;

  // An earlier verification script in this repo demoted a real staff member through a mis-scoped
  // locator. Nothing outside the accounts this run creates may change; that is asserted, not hoped.
  const bystandersBefore = sql(
    `select username || '=' || "platformRole" from "User" where "platformRole" <> 'USER' order by username;`,
  );

  await register(uploaderName);
  await register(reporterName);
  const staffToken = await register(staffName);

  const browser = await chromium.launch({ headless: true });
  const uploaderPage = await browser.newPage();
  const staffPage = await browser.newPage();
  const reporterPage = await browser.newPage();
  for (const p of [uploaderPage, staffPage, reporterPage]) {
    p.on("pageerror", (e) => bad("uncaught page error", String(e)));
  }
  let videoId = null;

  try {
    // --- Upload with tags, through the real picker -----------------------------------------
    await login(uploaderPage, uploaderName);
    await uploaderPage.goto(`${BASE}/foryou`, { waitUntil: "networkidle" });
    await uploaderPage.getByRole("button", { name: /upload/i }).first().click();
    await uploaderPage.locator('input[type="file"]').setInputFiles(CLIP);
    await uploaderPage.getByPlaceholder(/add a caption/i).fill(`tag verification ${rand}`);

    const tagInput = uploaderPage.getByLabel("Add a tag");
    await tagInput.fill(TAG_TYPED);
    await tagInput.press("Enter");
    // The chip is the only evidence the normalisation preview ran; a tag that is accepted but not
    // shown is indistinguishable from one silently dropped.
    if ((await uploaderPage.getByRole("button", { name: `Remove tag ${TAG_TYPED}` }).count()) === 1) {
      ok(`typed tag became a chip (#${TAG_TYPED})`);
    } else {
      bad(`typed tag did not produce a chip`);
    }

    // A tag that normalises to nothing must be refused rather than sent to the server as junk.
    await tagInput.fill("!!!");
    await tagInput.press("Enter");
    const chipCount = await uploaderPage.getByRole("button", { name: /^Remove tag / }).count();
    if (chipCount === 1) ok("an unnormalisable tag was refused client-side");
    else bad(`unnormalisable tag produced ${chipCount} chips, expected 1`);

    await uploaderPage.getByRole("button", { name: /^upload$/i }).last().click();
    await uploaderPage.getByText(/it's being processed/i).waitFor({ timeout: 60000 });

    videoId = sql(
      `select id from "Video" where "authorId" = (select id from "User" where username = '${uploaderName}') order by id desc limit 1;`,
    );
    const storedTags = sql(
      `select t.name from "VideoTag" vt join "Tag" t on t.id = vt."tagId" where vt."videoId" = ${videoId} order by t.name;`,
    );
    if (storedTags === TAG_TYPED) ok(`tag reached the database (${storedTags})`);
    else bad(`database tags are "${storedTags}", expected "${TAG_TYPED}"`);

    await waitForReview(videoId);

    // --- Staff review: tags visible, provenance NOT offered below master --------------------
    sql(`update "User" set "platformRole" = 'STAFF' where username = '${staffName}';`);
    await login(staffPage, staffName);
    await staffPage.goto(`${BASE}/staff/videos`, { waitUntil: "networkidle" });
    await staffPage.getByText(`tag verification ${rand}`).waitFor({ timeout: 20000 });

    if ((await staffPage.getByText(`#${TAG_TYPED}`).count()) > 0) {
      ok("review queue shows the video's tags");
    } else {
      bad("review queue rendered no tags for a tagged video");
    }
    if ((await staffPage.getByRole("button", { name: /show upload provenance/i }).count()) === 0) {
      ok("staff are not offered the provenance control");
    } else {
      bad("a STAFF account was offered provenance, which is master-only");
    }
    // The control being hidden is presentation; the route refusing is the actual boundary.
    const staffProbe = await api(`/master/videos/${videoId}/provenance`, {
      headers: { authorization: `Bearer ${staffToken}` },
    });
    if (staffProbe.status === 403) ok("provenance route refuses a staff token (403)");
    else bad(`provenance route returned ${staffProbe.status} to staff, expected 403`);

    await api(`/staff/videos/${videoId}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${staffToken}`, "content-type": "application/json" },
      body: "{}",
    });

    // --- Feed: tag chips render and filter --------------------------------------------------
    await login(reporterPage, reporterName);
    await reporterPage.goto(`${BASE}/foryou`, { waitUntil: "networkidle" });
    const chip = reporterPage.getByRole("button", { name: `#${TAG_TYPED}` }).first();
    await chip.waitFor({ timeout: 30000 });
    ok("approved video renders its tag as a chip in the feed");

    const unfiltered = await reporterPage.locator("[data-video-id]").count();

    // The request the click causes is asserted directly: a filter that only hid cards locally would
    // leave the same DOM count on a short feed and look identical.
    const [filterRequest] = await Promise.all([
      reporterPage.waitForRequest((r) => r.url().includes("/api/feed?") && r.url().includes("tag="), {
        timeout: 15000,
      }),
      chip.click(),
    ]);
    if (filterRequest.url().includes(`tag=${TAG_TYPED}`)) {
      ok("tapping a tag asks the server for that tag");
    } else {
      bad(`filter request was ${filterRequest.url()}`);
    }

    await reporterPage.getByText("Clear filter").waitFor({ timeout: 15000 });
    await reporterPage.waitForTimeout(1500);
    const filteredIds = await reporterPage.locator("[data-video-id]").evaluateAll((els) =>
      els.map((e) => e.dataset.videoId),
    );
    if (filteredIds.length === 1 && filteredIds[0] === String(videoId)) {
      ok(`filtered feed shows only the tagged video (was ${unfiltered} unfiltered)`);
    } else {
      bad(`filtered feed shows ${filteredIds.length} videos: ${filteredIds.join(",")}`);
    }

    // --- Report, resolve, rate --------------------------------------------------------------
    await reporterPage.getByRole("button", { name: "Report this video" }).first().click();
    await reporterPage.getByRole("button", { name: "Spam or misleading" }).click();
    await reporterPage.getByRole("button", { name: /submit report/i }).click();
    await reporterPage.getByText(/sent to the moderation team/i).waitFor({ timeout: 15000 });

    const reportId = sql(
      `select id from "VideoReport" where "reporterId" = (select id from "User" where username = '${reporterName}') limit 1;`,
    );
    if (reportId) ok("report was filed from the feed");
    else bad("no VideoReport row was created");

    await api(`/staff/reports/${reportId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${staffToken}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "COMPLETED", note: "Verified and actioned." }),
    });

    await reporterPage.goto(`${BASE}/foryou`, { waitUntil: "networkidle" });
    await reporterPage.getByRole("button", { name: /my reports/i }).click();
    await reporterPage.getByText("Verified and actioned.").waitFor({ timeout: 20000 });
    ok("My reports shows the moderator's resolution note");

    await reporterPage.getByRole("button", { name: `Rate report ${reportId} 4 stars` }).click();
    await reporterPage.waitForTimeout(1500);
    const storedRating = sql(`select coalesce(rating::text,'null') from "VideoReport" where id = '${reportId}';`);
    if (storedRating === "4") ok("star rating persisted to the database (4)");
    else bad(`database rating is ${storedRating} after clicking 4 stars`);

    // The rating is the only source of leaderboard points, which is why its absence made the whole
    // leaderboard inert.
    const board = await (
      await api("/staff/reports/leaderboard", {
        headers: { authorization: `Bearer ${staffToken}` },
      })
    ).json();
    const entry = board.leaderboard.find((e) => e.user.username === staffName);
    if (entry?.points === 4) ok("leaderboard credited the resolver 4 points");
    else bad(`leaderboard shows ${entry?.points ?? "no entry"} points for the resolver`);

    // --- Provenance, as master ---------------------------------------------------------------
    // Login already happened, and reconcilePlatformRole only runs at login — so this holds for
    // this session and reverts on the next one. MASTER_EMAIL is never touched.
    sql(`update "User" set "platformRole" = 'MASTER' where username = '${staffName}';`);
    await staffPage.goto(`${BASE}/staff/videos`, { waitUntil: "networkidle" });
    // The tab carries a pending count in its label, so this cannot be an exact match.
    await staffPage.getByRole("button", { name: /^Approved/ }).click();
    const provButton = staffPage.getByRole("button", { name: /show upload provenance/i }).first();
    await provButton.waitFor({ timeout: 20000 });
    ok("master is offered the provenance control");

    const auditBefore = Number(
      sql(`select count(*) from "StaffAuditLog" where "actionType" = 'PROVENANCE_VIEW' and "targetId" = '${videoId}';`),
    );
    await provButton.click();
    await staffPage.getByText(/SHA-256/i).waitFor({ timeout: 15000 });

    const shownIp = await staffPage.locator("dd").filter({ hasText: /\d+\.\d+\.\d+\.\d+|::/ }).count();
    if (shownIp > 0) ok("provenance panel rendered the upload IP");
    else bad("provenance panel showed no IP");

    const dbSha = sql(`select coalesce(sha256,'') from "Video" where id = ${videoId};`);
    if (dbSha && (await staffPage.getByText(dbSha).count()) > 0) {
      ok("provenance panel shows the file's real SHA-256");
    } else {
      bad("provenance panel's SHA-256 does not match the database");
    }

    const auditAfter = Number(
      sql(`select count(*) from "StaffAuditLog" where "actionType" = 'PROVENANCE_VIEW' and "targetId" = '${videoId}';`),
    );
    if (auditAfter === auditBefore + 1) ok("viewing provenance wrote exactly one audit entry");
    else bad(`audit entries went ${auditBefore} -> ${auditAfter}, expected +1`);
  } catch (e) {
    bad("tags / reports / provenance flow", String(e));
    for (const [name, p] of [["uploader", uploaderPage], ["staff", staffPage], ["reporter", reporterPage]]) {
      await p.screenshot({ path: `/tmp/verify-tags-ui-${name}.png`, fullPage: true }).catch(() => {});
    }
    console.log("screenshots: /tmp/verify-tags-ui-*.png");
  } finally {
    await browser.close();

    // Video.authorId is SetNull, so deleting the accounts alone would leave an orphaned approved
    // video in the public feed forever. Media rows go first.
    if (videoId) {
      sql(`delete from "VideoReport" where "videoId" = ${videoId};`);
      sql(`delete from "VideoTag" where "videoId" = ${videoId};`);
      sql(`delete from "VideoLike" where "videoId" = ${videoId};`);
      sql(`delete from "Video" where id = ${videoId};`);
    }
    sql(`delete from "Tag" where name = '${TAG_TYPED}';`);
    sql(
      `delete from "User" where username in ('${uploaderName}', '${staffName}', '${reporterName}');`,
    );
    console.log("cleaned up test accounts, video and tag");

    const bystandersAfter = sql(
      `select username || '=' || "platformRole" from "User" where "platformRole" <> 'USER' order by username;`,
    );
    if (bystandersAfter === bystandersBefore) {
      ok("no pre-existing role holder was modified");
    } else {
      bad(`this run changed someone else's role\n  before: ${bystandersBefore}\n  after:  ${bystandersAfter}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
