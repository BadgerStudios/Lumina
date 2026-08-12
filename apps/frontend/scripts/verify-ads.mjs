// Verifies the self-serve ad platform against the REAL deployment.
//
// Three things have to be true for an ad system to be defensible, and each is asserted here:
// an advertiser cannot promote something a moderator hasn't approved, an ad cannot appear without
// being labelled, and an advertiser is never billed twice for reaching the same person.
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
const rand = Date.now();
const PASSWORD = "verify-ads-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();

async function mkUser(username) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01",
    }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  // Aged past the connection-origin trust window (modules/risk/service.ts, TRUST_WINDOW_DAYS = 3).
  // This box's egress is a datacenter IP, so a brand-new account here is refused ad purchases by
  // design — correct behaviour, but not what this suite is testing. See verify-ip-intel.mjs, which
  // asserts the gate itself.
  sql(`update "User" set "createdAt" = now() - interval '30 days' where username = '${username}';`);
  return (await res.json()).accessToken;
}

const call = async (token, path, init = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
};

const firstLine = (out) => out.split("\n")[0].trim();

async function main() {
  const advertiser = `vads_adv_${rand}`;
  const viewer = `vads_view_${rand}`;
  const staff = `vads_staff_${rand}`;
  let campaignId = null;

  try {
    const advToken = await mkUser(advertiser);
    const viewToken = await mkUser(viewer);
    await mkUser(staff);
    sql(`update "User" set "platformRole" = 'STAFF' where username = '${staff}';`);
    const staffToken = (await (await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailOrUsername: staff, password: PASSWORD }),
    })).json()).accessToken;

    // A real approved video to promote. Reusing one from the feed rather than uploading keeps this
    // inside the upload rate limit.
    const feed = await (await fetch(`${BASE}/api/feed?limit=5`, {
      headers: { authorization: `Bearer ${advToken}` },
    })).json();
    const someoneElsesVideo = feed.videos[0];
    if (!someoneElsesVideo) return bad("no approved video in the feed to test against");

    // --- you cannot promote a video that isn't yours --------------------------------------------
    const notMine = await call(advToken, "/ads/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "someone else's video", videoId: someoneElsesVideo.id,
        cpmCents: 200, totalBudgetCents: 1000, startsAt: day(-1), endsAt: day(7),
      }),
    });
    if (notMine.status === 404) ok("you cannot promote a video you don't own");
    else bad(`promoting another user's video returned ${notMine.status}`);

    // Give the advertiser their own approved video by reassigning one directly — uploading and
    // waiting for a human approval isn't something a test can do.
    const advId = sql(`select id from "User" where username = '${advertiser}';`);
    // `RETURNING id` makes psql print the value AND its "INSERT 0 1" status line, so only the
    // first line is the id — passing the whole thing into the next query is a syntax error.
    const promo = firstLine(sql(
      `insert into "Video" ("authorId", caption, status, "sourceKey", "playbackKey", "thumbnailKey", "mimeType", "sizeBytes", sha256, "durationMs", "updatedAt") ` +
        `select '${advId}', 'verify ad creative ${rand}', 'PENDING_REVIEW', "sourceKey", "playbackKey", "thumbnailKey", "mimeType", "sizeBytes", 'ad${rand}', "durationMs", now() ` +
        `from "Video" where id = ${someoneElsesVideo.id} returning id;`,
    ));

    // --- and you cannot promote one that isn't approved yet --------------------------------------
    const notApproved = await call(advToken, "/ads/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "pending creative", videoId: promo,
        cpmCents: 200, totalBudgetCents: 1000, startsAt: day(-1), endsAt: day(7),
      }),
    });
    if (notApproved.status === 400) ok("an unapproved video cannot be promoted — ads inherit video review");
    else bad(`promoting a PENDING_REVIEW video returned ${notApproved.status}`);

    sql(`update "Video" set status = 'APPROVED' where id = ${promo};`);

    // --- a valid campaign ------------------------------------------------------------------------
    const created = await call(advToken, "/ads/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `verify campaign ${rand}`, videoId: promo,
        cpmCents: 5000, totalBudgetCents: 100000, startsAt: day(-1), endsAt: day(7),
      }),
    });
    if (created.status !== 201) return bad(`creating a campaign returned ${created.status}: ${created.body?.error}`);
    campaignId = created.body.id;

    if (created.body.status === "PENDING_REVIEW") ok("a new campaign goes straight to review, never live");
    else bad(`a new campaign was created as ${created.body.status}`);

    // An advertiser must not be able to approve their own campaign.
    const selfApprove = await call(advToken, `/ads/review/${campaignId}`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    });
    if (selfApprove.status === 403) ok("an advertiser cannot approve their own campaign");
    else bad(`self-approval returned ${selfApprove.status}`);

    // --- while pending, it must not deliver -------------------------------------------------------
    const feedBefore = await (await fetch(`${BASE}/api/feed?limit=30`, {
      headers: { authorization: `Bearer ${viewToken}` },
    })).json();
    if (!feedBefore.videos.some((v) => v.sponsoredBy)) ok("an unreviewed campaign does not appear in the feed");
    else bad("a campaign delivered before it was reviewed");

    // --- approve, then it should ------------------------------------------------------------------
    const approved = await call(staffToken, `/ads/review/${campaignId}`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    });
    if (approved.status === 200) ok("staff can approve a campaign");
    else return bad(`approval returned ${approved.status}`);

    const feedAfter = await (await fetch(`${BASE}/api/feed?limit=30`, {
      headers: { authorization: `Bearer ${viewToken}` },
    })).json();
    const sponsored = feedAfter.videos.filter((v) => v.sponsoredBy);
    if (sponsored.length > 0) ok(`the approved campaign delivers (${sponsored.length} sponsored card(s))`);
    else bad("an approved, in-window, in-budget campaign did not deliver");

    // Every sponsored card must carry the campaign id the label and beacon are driven by. An ad
    // that renders without it is an unlabelled ad.
    if (sponsored.every((v) => typeof v.sponsoredBy === "string" && v.sponsoredBy.length > 0)) {
      ok("every sponsored card is tagged so it renders a Sponsored label");
    } else {
      bad("a sponsored card arrived without a campaign id");
    }

    // The advertiser must never be shown their own ad.
    const ownFeed = await (await fetch(`${BASE}/api/feed?limit=30`, {
      headers: { authorization: `Bearer ${advToken}` },
    })).json();
    if (!ownFeed.videos.some((v) => v.sponsoredBy === campaignId)) {
      ok("an advertiser is never billed for reaching themselves");
    } else {
      bad("the advertiser was shown their own ad");
    }

    // --- billing is deduped ------------------------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      await call(viewToken, `/ads/campaigns/${campaignId}/impression`, { method: "POST", body: "{}" });
    }
    await new Promise((r) => setTimeout(r, 1500));
    const impressions = Number(sql(`select "impressionCount" from "AdCampaign" where id = '${campaignId}';`));
    if (impressions === 1) ok("four impressions from one viewer bill exactly once");
    else bad(`one viewer produced ${impressions} billable impressions`);

    // At $50 CPM an impression is 5 cents, so one impression must have accrued exactly 5.
    const spent = Number(sql(`select "spentCents" from "AdCampaign" where id = '${campaignId}';`));
    if (spent === 5) ok(`spend accrued correctly ($50 CPM x 1 impression = ${spent}c)`);
    else bad(`spend is ${spent}c; expected 5c`);

    const daily = sql(`select impressions || '/' || "spentCents" from "AdCampaignDaily" where "campaignId" = '${campaignId}';`);
    if (daily === "1/5") ok("the daily rollup agrees with the campaign counter");
    else bad(`the daily rollup says ${daily}, the campaign says ${impressions}/${spent}`);

    // --- taking the creative down stops delivery ----------------------------------------------------
    sql(`update "Video" set status = 'REMOVED' where id = ${promo};`);
    const feedAfterRemoval = await (await fetch(`${BASE}/api/feed?limit=30`, {
      headers: { authorization: `Bearer ${viewToken}` },
    })).json();
    if (!feedAfterRemoval.videos.some((v) => v.sponsoredBy === campaignId)) {
      ok("removing the creative stops the campaign immediately");
    } else {
      bad("a campaign kept delivering a video that had been taken down");
    }
  } catch (e) {
    bad(`ads flow: ${String(e).split("\n")[0]}`);
  } finally {
    if (campaignId) sql(`delete from "AdCampaign" where id = '${campaignId}';`);
    sql(`delete from "Video" where sha256 = 'ad${rand}';`);
    sql(`delete from "User" where username in ('${advertiser}', '${viewer}', '${staff}');`);
    console.log(`cleaned up ${advertiser}, ${viewer}, ${staff}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
