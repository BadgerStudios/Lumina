// Playwright screenshot walk of the ENTIRE platform: every public page, every authed surface,
// every modal, every settings section, the full parental flow, and the mobile drawers. Each
// screen also gets two mechanical checks a screenshot alone can't fail on: page console errors
// and horizontal document overflow (the "clipped ≠ overflow" lesson — scrollWidth lies about
// clipping, but overflow it does catch, and the screenshots catch the clipping).
//
// Output: PASS/SKIP per step + PNGs in SHOTS_DIR for human review. SKIP is loud, never silent.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-1000/-home-lucid/52e78ae3-2893-4b62-a3dd-19e6c57b498a/scratchpad/shots";
mkdirSync(SHOTS, { recursive: true });
const rand = Date.now();
let pass = 0, skip = 0, warn = 0, shotCount = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const sk = (m, e) => (console.log("SKIP: " + m + (e ? " -- " + String(e).slice(0, 120) : "")), skip++);
const wr = (m) => (console.log("WARN: " + m), warn++);

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
}
const birth = (y) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

const consoleErrors = new Map(); // shot name -> [errors]
function watch(page, label) {
  page.on("pageerror", (e) => (consoleErrors.get(label) ?? consoleErrors.set(label, []).get(label)).push?.(String(e)));
}

async function shot(page, name) {
  shotCount++;
  const n = String(shotCount).padStart(2, "0");
  await page.waitForTimeout(600); // settle animations/queries
  await page.screenshot({ path: `${SHOTS}/${n}-${name}.png`, fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) wr(`${name}: horizontal overflow of ${overflow}px`);
  return `${n}-${name}`;
}

const browser = await chromium.launch({ headless: true });

// ---------------------------------------------------------------- 1. public pages, both viewports
for (const [vp, size] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  for (const [path, name, waitMode] of [
    ["/", "landing"], ["/features", "features"], ["/install", "install"],
    ["/terms", "terms"], ["/privacy", "privacy"], ["/login", "login"], ["/register", "register"],
    ["/developers", "dev-portal"], ["/developers/getting-started", "dev-docs-start"],
    ["/developers/discord-compat", "dev-docs-discord"], ["/developers/apps", "dev-apps-signedout"],
  ]) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20000 });
      await shot(page, `${name}-${vp}`);
      ok(`${name} (${vp})`);
    } catch (e) { sk(`${name} (${vp})`, e); }
  }
  if (errs.length) wr(`public pages (${vp}) console errors: ${errs.slice(0, 3).join(" | ")}`);
  await ctx.close();
}

// ---------------------------------------------------------------- 2. authed desktop walk
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const authErrs = [];
page.on("pageerror", (e) => authErrs.push(String(e)));

const username = `qq_shot_${rand}`;
try {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill("password123");
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await shot(page, "register-filled");
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 15000 });
  ok("registered through the real form");
} catch (e) { sk("registration", e); }

// server via UI modal
try {
  await page.getByRole("button", { name: "Add a Server" }).click();
  await shot(page, "modal-create-server");
  await page.getByLabel("Server name").fill("Shot Walk Server");
  await page.getByRole("button", { name: /create/i }).click();
  await page.waitForURL(/\/channels\/.+/, { timeout: 15000 });
  ok("create-server modal + landed in channel");
} catch (e) { sk("create server", e); }

// chat surface
try {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("Visual walk message — checking the chat surface end to end.");
  await composer.press("Enter");
  await page.getByText("Visual walk message").waitFor({ timeout: 8000 });
  await page.getByText("Visual walk message").hover();
  await shot(page, "chat-message-hover");
  ok("chat + message hover toolbar");
} catch (e) { sk("chat surface", e); }

// slash palette
try {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("/");
  await shot(page, "chat-slash-palette");
  await composer.fill("");
  ok("slash command palette");
} catch (e) { sk("slash palette", e); }

// inbox bell
try {
  await page.getByLabel(/inbox|notifications/i).or(page.locator("button:has(svg.lucide-bell)")).first().click();
  await shot(page, "inbox-popover");
  await page.keyboard.press("Escape");
  ok("inbox bell popover");
} catch (e) { sk("inbox popover", e); }

// server dropdown + its modals
const dropdownItems = [
  ["Invite People", "modal-invite"],
  ["Leaderboard", "modal-leaderboard"],
  ["Events", "modal-events"],
  ["Notification Settings", "modal-notification-settings"],
];
for (const [item, name] of dropdownItems) {
  try {
    await page.getByText("Shot Walk Server", { exact: true }).first().click();
    if (name === "modal-invite") await shot(page, "server-dropdown-open");
    await page.getByRole("menuitem", { name: item }).click({ timeout: 4000 });
    await shot(page, name);
    await page.keyboard.press("Escape");
    ok(name);
  } catch (e) { sk(name, e); await page.keyboard.press("Escape").catch(() => {}); }
}

// server settings tabs
try {
  await page.getByText("Shot Walk Server", { exact: true }).first().click();
  await page.getByText("Server Settings", { exact: true }).click({ timeout: 4000 });
  await page.waitForTimeout(800);
  for (const tab of ["Overview", "Moderation", "Community", "Expressions", "Roles", "Bans", "Audit Log", "Webhooks", "AutoMod", "Addons"]) {
    try {
      await page.getByText(tab, { exact: true }).first().click({ timeout: 3000 });
      await shot(page, `server-settings-${tab.toLowerCase().replace(/\s|-/g, "")}`);
      ok(`server settings tab: ${tab}`);
    } catch (e) { sk(`server settings tab ${tab}`, e); }
  }
  await page.keyboard.press("Escape");
} catch (e) { sk("server settings modal", e); }

// user settings — every section
try {
  await page.locator('button[title="User Settings"]').click();
  await page.waitForTimeout(600);
  for (const section of ["My Account", "Devices & Sessions", "Appearance", "Privacy & Safety", "Family", "Connections", "Notifications", "Billing", "Advertising", "Developer Portal", "Voice & Video"]) {
    try {
      await page.getByText(section, { exact: true }).first().click({ timeout: 3000 });
      await shot(page, `settings-${section.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      ok(`settings section: ${section}`);
    } catch (e) { sk(`settings section ${section}`, e); }
  }
  await page.keyboard.press("Escape");
} catch (e) { sk("user settings modal", e); }

// top-level routes
for (const [path, name, waitMode] of [
  ["/friends", "friends"], ["/foryou", "feed", "domcontentloaded"], ["/discover", "discover"],
  ["/studio", "studio"], ["/store", "store"], ["/upload", "upload-page"],
  ["/developers/apps", "dev-apps-signedin"],
]) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: waitMode ?? "networkidle", timeout: 20000 });
    await shot(page, name);
    ok(`route ${path}`);
  } catch (e) { sk(`route ${path}`, e); }
}

// ---------------------------------------------------------------- 3. parental flow
let parentToken = null, minorToken = null;
try {
  const login = await api("/auth/login", { method: "POST", body: { emailOrUsername: username, password: "password123" } });
  parentToken = login.json?.accessToken;
  const m = await api("/auth/register", { method: "POST", body: { username: `qq_shotkid_${rand}`, email: `qq_shotkid_${rand}@example.com`, password: "password123", birthDate: birth(16), ageBracket: "UNDER_18" } });
  minorToken = m.json?.accessToken;
  ok("parental actors created (parent via login, minor 16yo registered)");
} catch (e) { sk("parental actor setup", e); }

// minor's locked gate
try {
  const mctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await mpage.getByLabel(/username|email/i).first().fill(`qq_shotkid_${rand}`);
  await mpage.getByLabel("Password").fill("password123");
  await mpage.getByRole("button", { name: /log in|sign in/i }).click();
  await mpage.waitForTimeout(2500);
  await shot(mpage, "minor-locked-gate");
  ok("minor locked gate (pre-pairing)");

  // pair via API, reload minor → safety prompt
  const code = (await api("/parental/me/pairing-code", { method: "POST", token: minorToken })).json?.pairingCode;
  await api("/parental/redeem", { method: "POST", token: parentToken, body: { code } });
  await mpage.reload({ waitUntil: "networkidle" });
  await mpage.waitForTimeout(2500);
  await shot(mpage, "minor-after-pairing-safety-prompt");
  ok("minor post-pairing view (safety prompt / unlocked)");
  await mctx.close();
} catch (e) { sk("minor gate walk", e); }

// parent's Family section, all four tabs — navigate back to the app first (the walk
// left the page on the dev portal, which has no sidebar and no settings button).
try {
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle", timeout: 20000 });
  await page.locator('button[title="User Settings"]').click();
  await page.getByText("Family", { exact: true }).first().click({ timeout: 4000 });
  await shot(page, "family-overview");
  for (const tab of ["Who they talk to", "Messages", "Servers", "Allowed adults"]) {
    try {
      await page.getByText(tab, { exact: true }).last().click({ timeout: 3000 }); // .last(): the family tab, not the identically-named nav item behind the modal
      await shot(page, `family-${tab.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      ok(`family tab: ${tab}`);
    } catch (e) { sk(`family tab ${tab}`, e); }
  }
  await page.keyboard.press("Escape");
} catch (e) { sk("family section", e); }

// ---------------------------------------------------------------- 4. mobile authed walk
try {
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mob.newPage();
  await mp.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await mp.getByLabel(/username|email/i).first().fill(username);
  await mp.getByLabel("Password").fill("password123");
  await mp.getByRole("button", { name: /log in|sign in/i }).click();
  await mp.waitForTimeout(2500);
  await shot(mp, "mobile-home");
  ok("mobile home");
  for (const [label, name] of [["Servers", "mobile-drawer-servers"], ["Channels", "mobile-drawer-channels"], ["DMs", "mobile-drawer-dms"], ["Activity", "mobile-drawer-activity"]]) {
    try {
      await mp.getByLabel(label).or(mp.getByText(label, { exact: true })).first().click({ timeout: 3000 });
      await shot(mp, name);
      await mp.keyboard.press("Escape");
      ok(name);
    } catch (e) { sk(name, e); }
  }
  try {
    await mp.goto(`${BASE}/foryou`, { waitUntil: "networkidle" });
    await shot(mp, "mobile-feed");
    ok("mobile feed");
  } catch (e) { sk("mobile feed", e); }
  await mob.close();
} catch (e) { sk("mobile walk", e); }

if (authErrs.length) wr(`authed walk console errors: ${authErrs.slice(0, 5).join(" | ")}`);
await browser.close();
console.log(`\n${pass} passed, ${skip} skipped, ${warn} warnings, ${shotCount} screenshots in ${SHOTS}`);
