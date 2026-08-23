// Captures REAL screenshots of the current Lumina UI for the marketing homepage.
//
// Everything shown is seeded demo content on accounts this script creates (qq_mk_* — this
// session's throwaway prefix), never a real user's messages, name, or face. That's a hard rule:
// the public homepage must never surface a real person's private conversation.
//
// It registers a small cast of adult demo accounts, spins up a believable community server, seeds
// a natural conversation with reactions and a DM, then logs in through the real UI and shoots the
// app at retina scale across surfaces and themes. Curated shots are copied into public/screens/.
import { chromium } from "playwright";
import { mkdirSync, copyFileSync } from "node:fs";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/mk";
const PUBLIC = new URL("../public/screens/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const rand = Date.now().toString(36);
let n = 0;
const log = (m) => console.log(m);

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch {}
  if (res.status >= 300) log(`  ! ${method} ${path} -> ${res.status} ${JSON.stringify(json)?.slice(0, 160)}`);
  return { status: res.status, json };
}
const birth = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- cast -------------------------------------------------------------------------------------
const CAST = [
  { key: "maya", name: "Maya Chen", age: 29 },
  { key: "diego", name: "Diego Santos", age: 31 },
  { key: "priya", name: "Priya Nair", age: 26 },
  { key: "sam", name: "Sam Rivera", age: 24 },
  { key: "jordan", name: "Jordan Lee", age: 33 },
];

const actors = {};
async function register(a) {
  const username = `qq_mk_${a.key}_${rand}`;
  const r = await api("/auth/register", {
    method: "POST",
    body: {
      username,
      email: `${username}@example.com`,
      password: "password123",
      displayName: a.name,
      ageBracket: a.age < 25 ? "AGE_18_24" : a.age < 35 ? "AGE_25_34" : "AGE_35_49",
      birthDate: birth(a.age),
    },
  });
  actors[a.key] = { ...a, username, token: r.json?.accessToken, id: r.json?.user?.id ?? r.json?.id };
  return actors[a.key];
}

async function seed() {
  log("Seeding demo community…");
  for (const a of CAST) await register(a);
  const maya = actors.maya;
  if (!maya.token) throw new Error("owner registration failed");

  // Server + channels
  const srv = (await api("/servers", { method: "POST", token: maya.token, body: { name: "Aurora Collective" } })).json;
  const serverId = srv.id;
  const wanted = [
    { name: "introductions", type: "TEXT" },
    { name: "general", type: "TEXT" },
    { name: "design-crits", type: "TEXT" },
    { name: "dev", type: "TEXT" },
    { name: "Studio Lounge", type: "VOICE" },
  ];
  for (const c of wanted) await api(`/servers/${serverId}/channels`, { method: "POST", token: maya.token, body: c });
  const channels = (await api(`/servers/${serverId}/channels`, { token: maya.token })).json ?? [];
  const chan = (name) => channels.find((c) => c.name === name) ?? channels.find((c) => c.type === "TEXT");
  const general = chan("general");

  // Everyone joins
  const invite = (await api(`/servers/${serverId}/invites`, { method: "POST", token: maya.token, body: {} })).json;
  for (const k of ["diego", "priya", "sam", "jordan"]) {
    if (actors[k].token) await api(`/invites/${invite.code}/join`, { method: "POST", token: actors[k].token });
  }

  // A natural conversation. [author, channel, text]
  const script = [
    ["maya", "general", "morning everyone ☀️ pushed the new landing design to staging last night — would love eyes on the hero"],
    ["diego", "general", "ohh looking now. that gradient headline is 🔥"],
    ["priya", "general", "the live status pill is such a nice touch. is that pulling real numbers?"],
    ["maya", "general", "yep — real signup + online count straight from the API, updates every 30s"],
    ["sam", "general", "does the bento grid stack on mobile or stay a grid?"],
    ["maya", "general", "single column under 640px, already responsive. try it on your phone"],
    ["jordan", "general", "this is so clean. shipping today? 👀"],
    ["maya", "general", "if crits pass in #design-crits, absolutely 🚀"],
    ["diego", "general", "+1 from me, ship it"],
    ["priya", "general", "same, looks great on every theme i tried"],
  ];
  const msgIds = {};
  for (const [who, chName, text] of script) {
    const ch = chan(chName) ?? general;
    const r = await api(`/channels/${ch.id}/messages`, { method: "POST", token: actors[who].token, body: { content: text } });
    if (r.json?.id) msgIds[text.slice(0, 12)] = { id: r.json.id, ch: ch.id };
    await sleep(120);
  }
  // Reactions from assorted people, so the channel reads alive
  const react = async (key, who, emoji) => {
    const m = msgIds[key];
    if (m) await api(`/messages/${m.id}/reactions`, { method: "POST", token: actors[who].token, body: { emoji } });
  };
  await react("morning ever", "diego", "☀️");
  await react("morning ever", "priya", "🔥");
  await react("ohh looking ", "maya", "❤️");
  await react("this is so c", "maya", "🙏");
  await react("if crits pas", "jordan", "🚀");
  await react("if crits pas", "sam", "🚀");
  await react("same, looks ", "diego", "💜");

  // A DM thread, Maya <-> Diego
  const dm = (await api("/dm", { method: "POST", token: actors.maya.token, body: { participantIds: [actors.diego.id] } })).json;
  if (dm?.id) {
    const dmLine = async (who, text) => api(`/dm/${dm.id}/messages`, { method: "POST", token: actors[who].token, body: { content: text } });
    await dmLine("diego", "hey — got 5 mins for a quick voice sync on the feed ranking?");
    await dmLine("maya", "yeah! jumping into Studio Lounge now 🎧");
    await dmLine("diego", "👍 omw");
  }

  log(`  server=${serverId} general=${general?.id} dm=${dm?.id}`);
  return { serverId, generalId: general?.id, username: maya.username };
}

// ---- capture ----------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });

async function shot(page, name, curate) {
  n++;
  await page.waitForTimeout(700);
  const file = `${SHOTS}/${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file });
  if (curate) copyFileSync(file, `${PUBLIC}${curate}`);
  log(`  shot ${name}${curate ? ` -> public/screens/${curate}` : ""}`);
}

async function loginUI(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/username|email/i).first().fill(username);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  await page.waitForTimeout(2600);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem("lumina-theme", t), theme);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
}

const { serverId, generalId, username } = await seed();
const chatURL = `${BASE}/channels/${serverId}/${generalId}`;
const STATE = `${SHOTS}/state.json`;

// Desktop, retina
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => log(`  pageerror: ${String(e).slice(0, 120)}`));
await loginUI(page, username);
// Persist the authenticated session so the mobile context can reuse it directly — logging in
// fresh in a second context raced the app's token hydration and landed back on /login.
await ctx.storageState({ path: STATE });

// Chat hero in the default (nebula/dark) theme + a theme gallery of the SAME screen
await setTheme(page, "dark");
await page.goto(chatURL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shot(page, "chat-dark", "app-chat.png");

for (const [t, out] of [["midnight", "app-chat-midnight.png"], ["moss", "app-chat-moss.png"], ["light", "app-chat-daylight.png"], ["carbon", "app-chat-carbon.png"]]) {
  await setTheme(page, t);
  await page.goto(chatURL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, `chat-${t}`, out);
}

// back to dark for the remaining product surfaces
await setTheme(page, "dark");

// Mobile — done HERE, right after the (proven-authenticated) theme gallery, by resizing the SAME
// page to a phone. Auth lives in memory; a fresh context or a late navigation both raced it back
// to /login, so capture while the session is freshest, then resize back to desktop.
try {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(chatURL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  await shot(page, "mobile-chat", "app-mobile-chat.png");
} catch (e) { log("  mobile-chat skip " + e); }
try {
  await page.goto(`${BASE}/foryou`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2400);
  await shot(page, "mobile-feed", "app-mobile-feed.png");
} catch (e) { log("  mobile-feed skip " + e); }
await page.setViewportSize({ width: 1440, height: 900 });

// Slash command palette
try {
  await page.goto(chatURL, { waitUntil: "networkidle" });
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("/");
  await shot(page, "slash-palette", "app-slash.png");
  await composer.fill("");
} catch (e) { log("  slash skip " + e); }

// DMs
try {
  await page.goto(`${BASE}/friends`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "friends", "app-friends.png");
} catch (e) { log("  friends skip " + e); }

// Product routes
for (const [path, name, out] of [
  ["/foryou", "feed", "app-feed.png"],
  ["/discover", "discover", "app-discover.png"],
  ["/studio", "studio", "app-studio.png"],
]) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await shot(page, name, out);
  } catch (e) { log(`  ${name} skip ${e}`); }
}
await ctx.close();

await browser.close();
log(`\nDone: ${n} screenshots in ${SHOTS}`);
