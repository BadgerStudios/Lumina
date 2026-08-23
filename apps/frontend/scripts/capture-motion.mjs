// Records REAL product motion for the landing page: a live chat conversation and the mobile feed,
// captured from the running app against seeded demo accounts (qq_mv_* throwaways — never a real
// user's data, same hard rule as capture-marketing.mjs).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const OUT = process.env.OUT ?? "./out";
mkdirSync(OUT, { recursive: true });
const rand = Date.now().toString(36);
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { "x-client-type": "mobile" }; // native-app surface (documented Turnstile exemption)
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch {}
  if (res.status >= 300) log(`  ! ${method} ${path} -> ${res.status} ${JSON.stringify(json)?.slice(0, 160)}`);
  return { status: res.status, json };
}
const birth = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

const CAST = [
  { key: "maya", name: "Maya Chen", age: 29 },
  { key: "diego", name: "Diego Santos", age: 31 },
  { key: "priya", name: "Priya Nair", age: 26 },
  { key: "sam", name: "Sam Rivera", age: 24 },
];
const actors = {};
async function register(a) {
  const username = `qq_mv_${a.key}_${rand}`;
  const r = await api("/auth/register", {
    method: "POST",
    body: {
      username,
      email: `${username}@example.com`,
      password: "password123",
      displayName: a.name,
      ageBracket: a.age < 25 ? "AGE_18_24" : "AGE_25_34",
      birthDate: birth(a.age),
    },
  });
  actors[a.key] = { ...a, username, token: r.json?.accessToken, id: r.json?.user?.id ?? r.json?.id };
}

async function seed() {
  log("Seeding motion demo…");
  for (const a of CAST) await register(a);
  const maya = actors.maya;
  if (!maya.token) throw new Error("registration failed");
  const srv = (await api("/servers", { method: "POST", token: maya.token, body: { name: "Aurora Collective" } })).json;
  for (const c of [{ name: "general", type: "TEXT" }, { name: "showcase", type: "TEXT" }])
    await api(`/servers/${srv.id}/channels`, { method: "POST", token: maya.token, body: c });
  const channels = (await api(`/servers/${srv.id}/channels`, { token: maya.token })).json ?? [];
  const general = channels.find((c) => c.name === "general") ?? channels.find((c) => c.type === "TEXT");
  const invite = (await api(`/servers/${srv.id}/invites`, { method: "POST", token: maya.token, body: {} })).json;
  for (const k of ["diego", "priya", "sam"]) if (actors[k].token) await api(`/invites/${invite.code}/join`, { method: "POST", token: actors[k].token });
  // Pre-roll so the channel opens on a real conversation, not an empty room.
  const preroll = [
    ["maya", "okay the new build is up — server boosts, the soundboard, all of it 🚀"],
    ["diego", "installing now. the update pill in About is a nice touch btw"],
    ["priya", "voice quality last night was genuinely better than our old setup"],
    ["sam", "can confirm, zero drops in a 3 hour session 🎧"],
  ];
  for (const [who, text] of preroll) {
    await api(`/channels/${general.id}/messages`, { method: "POST", token: actors[who].token, body: { content: text } });
    await sleep(150);
  }
  log(`  server=${srv.id} general=${general.id}`);
  return { serverId: srv.id, generalId: general.id };
}

async function loginUI(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/username|email/i).first().fill(username);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForTimeout(2600);
}

// The live conversation that plays out ON CAMERA. [actor, text, pauseAfterMs]
const LIVE_SCRIPT = [
  ["diego", "yo did everyone see the aurora screenshots from the meetup?? 📸", 1600],
  ["priya", "posting mine in #showcase rn, the green ones came out unreal", 1900],
  ["sam", "the timelapse you got is going straight in the recap video", 1700],
  ["maya", "ok that settles it, next meetup we're going further north ❄️", 1800],
  ["diego", "voice chat in 10 to plan it? 🎙️", 1500],
  ["priya", "in 🙋", 1200],
  ["sam", "same, grabbing coffee first ☕", 1400],
];

const { serverId, generalId } = await seed();
const chatURL = `${BASE}/channels/${serverId}/${generalId}`;
const browser = await chromium.launch({ headless: true });

// ---- scene 1: desktop chat, conversation arriving live --------------------------------------
{
  log("Recording desktop chat…");
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  await loginUI(page, actors.maya.username);
  await page.evaluate(() => localStorage.setItem("lumina-theme", "dark"));
  await page.goto(chatURL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  for (const [who, text, pause] of LIVE_SCRIPT) {
    await api(`/channels/${generalId}/messages`, { method: "POST", token: actors[who].token, body: { content: text } });
    await page.waitForTimeout(pause);
  }
  // reactions popping in on the last few messages
  const msgs = (await api(`/channels/${generalId}/messages`, { token: actors.maya.token })).json ?? [];
  const list = Array.isArray(msgs) ? msgs : msgs.messages ?? [];
  const recent = list.slice(-4);
  for (const [i, emoji] of ["🔥", "❄️", "🎙️", "💜"].entries()) {
    const m = recent[i % recent.length];
    if (m?.id) await api(`/messages/${m.id}/reactions`, { method: "POST", token: actors.diego.token, body: { emoji } });
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1500);
  const video = page.video();
  await ctx.close();
  const p = await video.path();
  log(`  chat-desktop raw: ${p}`);
  await import("node:fs").then((fs) => fs.promises.rename(p, `${OUT}/chat-desktop.raw.webm`));
}

// ---- scene 2: mobile feed scroll --------------------------------------------------------------
{
  log("Recording mobile feed…");
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  await loginUI(page, actors.maya.username);
  await page.evaluate(() => localStorage.setItem("lumina-theme", "dark"));
  await page.goto(`${BASE}/foryou`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const hasVideo = await page.locator("video").count();
  if (hasVideo > 0) {
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(3800);
      await page.mouse.wheel(0, 900); // next item
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2000);
    const video = page.video();
    await ctx.close();
    const p = await video.path();
    log(`  feed-mobile raw: ${p}`);
    await import("node:fs").then((fs) => fs.promises.rename(p, `${OUT}/feed-mobile.raw.webm`));
  } else {
    log("  ! feed empty — skipping feed video (poster will show instead)");
    await ctx.close();
  }
}

// ---- scene 3: mobile chat, same conversation continuing --------------------------------------
{
  log("Recording mobile chat…");
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
    hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  await loginUI(page, actors.sam.username);
  await page.evaluate(() => localStorage.setItem("lumina-theme", "dark"));
  await page.goto(chatURL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const MOBILE_SCRIPT = [
    ["maya", "recap video draft is rendering, 2 min ⏳", 1800],
    ["diego", "drop it here when it's done!", 1600],
    ["priya", "first 10 seconds better be the timelapse 😤", 1700],
    ["maya", "obviously 😄", 1500],
  ];
  for (const [who, text, pause] of MOBILE_SCRIPT) {
    await api(`/channels/${generalId}/messages`, { method: "POST", token: actors[who].token, body: { content: text } });
    await page.waitForTimeout(pause);
  }
  await page.waitForTimeout(1500);
  const video = page.video();
  await ctx.close();
  const p = await video.path();
  log(`  chat-mobile raw: ${p}`);
  await import("node:fs").then((fs) => fs.promises.rename(p, `${OUT}/chat-mobile.raw.webm`));
}

await browser.close();
log("DONE capture");
