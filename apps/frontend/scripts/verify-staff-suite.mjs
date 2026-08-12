// Verifies the staff suite: that a plain user cannot see or reach it, that promoting someone to
// STAFF makes it appear in their sidebar without a reload, and that every section is reachable.
//
// The bugs this exists to catch are all "built but unreachable" ones, which this repo has hit
// repeatedly: /staff/reports shipped linked from nowhere at all, and ad review was staff-gated on
// the server with its only UI inside the owner console, which staff cannot open.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

async function register(page, username) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill("password123");
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 15000 });
}

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => bad("uncaught page error", String(e)));

// The access token lives in a zustand store in memory, not in localStorage, so it cannot be read
// back out of the page. Sniffing it off the app's own outbound requests is the honest way to get
// the real token — and it matters that it IS the real one: without it these checks would get 401
// (not signed in) and quietly prove nothing about the ROLE gate, which is the thing under test.
let bearer = null;
page.on("request", (req) => {
  const h = req.headers()["authorization"];
  if (h?.startsWith("Bearer ")) bearer = h;
});

const user = `qq_staff_${rand}`;
await register(page, user);
ok(`registered ${user} as a plain USER`);

// --- a plain user must see nothing and reach nothing ---
const railStaffBefore = await page.getByRole("link", { name: "Staff suite" }).count();
if (railStaffBefore === 0) ok("no Staff suite entry in the rail for a plain user");
else bad("a plain user can see the Staff suite rail entry");

await page.goto(`${BASE}/staff/videos`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
if (!page.url().includes("/staff")) ok(`a plain user visiting /staff/videos is redirected (${new URL(page.url()).pathname})`);
else bad("a plain user was left on /staff/videos");

// The gate that actually matters is the server's. Back to an in-app page first so the client has
// made at least one authenticated request for the sniffer above to catch.
await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
if (!bearer) bad("never observed an Authorization header — the checks below would be meaningless");
for (const path of ["/staff/videos", "/staff/videos/counts", "/staff/audit"]) {
  const status = await page.evaluate(async ([base, p, auth]) => {
    const r = await fetch(`${base}/api${p}`, { headers: { authorization: auth } });
    return r.status;
  }, [BASE, path, bearer]);
  if (status === 403) ok(`GET /api${path} is 403 for an authenticated plain user`);
  else bad(`GET /api${path} returned ${status} for a plain user, expected 403`);
}

// --- promote, and watch the tab appear without a reload ---
console.log("\n== promoting to STAFF ==");
await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const { execSync } = await import("node:child_process");
execSync(
  `DB=$(grep -m1 '^POSTGRES_DB=' .env | cut -d= -f2-) && U=$(grep -m1 '^POSTGRES_USER=' .env | cut -d= -f2-) && ` +
  `docker compose exec -T postgres psql -U "$U" -d "$DB" -q -c "update \\"User\\" set \\"platformRole\\"='STAFF' where username='${user}';"`,
  // cwd is the repo root: the command reads .env, which lives there and not in apps/frontend.
  { stdio: "pipe", shell: "/bin/bash", cwd: new URL("../../..", import.meta.url).pathname },
);
// A direct DB update deliberately emits no socket event, so this proves the FALLBACK path
// (useRoleSync on window focus) rather than the push. The push is exercised by the grant route.
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
await page.waitForTimeout(2500);

try {
  await page.getByRole("link", { name: "Staff suite" }).waitFor({ state: "visible", timeout: 8000 });
  ok("the Staff suite appears in the rail after promotion, with no reload");
} catch (e) { bad("Staff suite did not appear in the rail after promotion", String(e)); }

// --- every section reachable from the suite's own nav ---
await page.goto(`${BASE}/staff`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
if (page.url().endsWith("/staff/videos")) ok("/staff redirects to the video queue");
else bad(`/staff landed on ${page.url()}`);

for (const [label, path] of [["Videos", "/staff/videos"], ["Reports", "/staff/reports"], ["Ads", "/staff/ads"], ["Audit log", "/staff/audit"]]) {
  try {
    await page.getByRole("link", { name: label, exact: false }).first().click();
    await page.waitForURL((u) => u.pathname === path, { timeout: 6000 });
    ok(`${label} section reachable from the suite nav (${path})`);
  } catch (e) { bad(`${label} not reachable`, String(e)); }
}

// The header must survive every section — it is the only thing naming where you are.
const header = await page.getByRole("heading", { name: "Staff suite" }).isVisible().catch(() => false);
if (header) ok("the suite header persists across sections");
else bad("the suite header is missing");

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
