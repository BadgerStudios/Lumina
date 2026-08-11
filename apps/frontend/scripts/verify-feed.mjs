/**
 * Browser verification of the feed UI — the parts no API test can cover: does a card actually
 * play, does exactly one play at a time, does the staff entry stay hidden from ordinary users.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "https://lumina.luxffa.com";
const CLIP = "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/test-clip.mp4";
const STAFF_TOKEN = process.env.STAFF_TOKEN;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, opts = {}) {
  return fetch(`${BASE}/api${path}`, opts);
}

async function register(tag) {
  const stamp = Date.now() + Math.floor(Math.random() * 10000);
  const body = {
    username: `ui_${tag}_${stamp}`,
    email: `ui_${tag}_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34", birthDate: "1995-06-15",
  };
  const res = await api("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ...body, token: json.accessToken, user: json.user };
}

/** Seeds N approved videos so the feed has something to scroll. */
async function seedApproved(count) {
  const clip = readFileSync(CLIP);
  const uploader = await register("up");
  const ids = [];
  for (let i = 0; i < count; i++) {
    const form = new FormData();
    form.append("caption", `ui verification clip ${i + 1}`);
    form.append("file", new Blob([clip], { type: "video/mp4" }), "clip.mp4");
    const res = await api("/videos", {
      method: "POST",
      headers: { authorization: `Bearer ${uploader.token}` },
      body: form,
    });
    ids.push((await res.json()).id);
  }
  // wait for transcode
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const list = await (await api("/videos/mine", {
      headers: { authorization: `Bearer ${uploader.token}` },
    })).json();
    const relevant = list.filter((v) => ids.includes(v.id));
    if (relevant.length === count && relevant.every((v) => v.status === "PENDING_REVIEW")) break;
  }
  for (const id of ids) {
    await api(`/videos/${id}/approve`.replace("/videos/", "/staff/videos/"), {
      method: "POST",
      headers: { authorization: `Bearer ${STAFF_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
  }
  return { uploader, ids };
}

async function main() {
  if (!STAFF_TOKEN) throw new Error("STAFF_TOKEN required");

  console.log("seeding approved videos...");
  const { ids } = await seedApproved(3);
  console.log(`seeded ${ids.length} approved videos\n`);

  const viewer = await register("v");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: [],
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("  [browser error]", msg.text());
  });

  // --- log in through the real UI ---
  await page.goto(`${BASE}/login`);
  // The login form has no placeholders — labels wrap the inputs — so select positionally within
  // the form rather than by placeholder text.
  await page.locator("form input:not([type=password])").first().fill(viewer.username);
  await page.locator('form input[type="password"]').fill(viewer.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 15000 }).catch(() => {});
  check("logged in via UI", !page.url().includes("/login"), page.url());

  // --- staff entry hidden for a non-staff user ---
  const staffLink = page.locator('a[title="Video review (staff)"]');
  check("staff rail entry hidden from ordinary user", (await staffLink.count()) === 0);

  // --- navigate to the feed via the rail ---
  await page.locator('a[title="For You"]').click();
  await page.waitForURL(/\/foryou/, { timeout: 10000 });
  check("For You rail entry navigates to the feed", page.url().includes("/foryou"));

  // --- a video element appears and starts playing ---
  await page.waitForSelector("video", { timeout: 20000 });
  const cardCount = await page.locator("[data-video-id]").count();
  check("feed rendered video cards", cardCount > 0, `${cardCount} card(s)`);

  // Give autoplay a moment; muted autoplay is permitted so this should start on its own.
  await page.waitForTimeout(4000);

  const playState = await page.evaluate(() => {
    const vids = Array.from(document.querySelectorAll("video"));
    return vids.map((v) => ({
      paused: v.paused,
      currentTime: v.currentTime,
      muted: v.muted,
      readyState: v.readyState,
    }));
  });
  const playing = playState.filter((v) => !v.paused);
  check("exactly one video is playing", playing.length === 1,
    `${playing.length} playing of ${playState.length}: ${JSON.stringify(playState)}`);
  check("playing video actually advanced (real playback)", playing[0]?.currentTime > 0,
    `currentTime=${playing[0]?.currentTime}`);
  check("autoplay starts muted (browser policy)", playState.every((v) => v.muted));

  // --- scroll to the next card; playback should move with it ---
  if (cardCount > 1) {
    const firstId = await page.locator("[data-video-id]").first().getAttribute("data-video-id");
    await page.evaluate(() => {
      const scroller = document.querySelector(".snap-y");
      if (scroller) scroller.scrollTop = scroller.clientHeight;
    });
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("[data-video-id]"));
      return cards.map((c) => ({
        id: c.dataset.videoId,
        paused: c.querySelector("video")?.paused,
      }));
    });
    const nowPlaying = after.filter((c) => c.paused === false);
    check("after scrolling, still exactly one video plays", nowPlaying.length === 1,
      `${nowPlaying.length} playing`);
    check("scrolling moved playback to a different card",
      nowPlaying.length === 1 && nowPlaying[0].id !== firstId,
      `was ${firstId}, now ${nowPlaying[0]?.id}`);
  }

  // --- like via the UI ---
  const likeBtn = page.getByRole("button", { name: /^Like$/ }).first();
  if (await likeBtn.count()) {
    await likeBtn.click();
    await page.waitForTimeout(1500);
    const unlikeVisible = await page.getByRole("button", { name: /^Unlike$/ }).count();
    check("like button toggles to Unlike", unlikeVisible > 0);
  } else {
    check("like button toggles to Unlike", false, "no Like button found");
  }

  await page.screenshot({
    path: "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/feed-ui.png",
  });

  // --- staff user sees the review route ---
  const staffPage = await context.newPage();
  await staffPage.goto(`${BASE}/staff/videos`);
  await staffPage.waitForTimeout(2000);
  // This context is the ordinary viewer, so the guard should bounce them off the staff route.
  check("non-staff redirected away from /staff/videos",
    !staffPage.url().includes("/staff"), staffPage.url());

  await browser.close();

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
