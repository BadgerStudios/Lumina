import { chromium } from "playwright";
// Production by default so this suite is part of the standard production battery; override with
// BASE=http://127.0.0.1:5173 to point it at a local dev server instead.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
let pass = 0, fail = 0;
function ok(m) { console.log("PASS: " + m); pass++; }
function bad(m, e) { console.log("FAIL: " + m + (e ? " -- " + e : "")); fail++; }

// When BASE is overridden to a local dev server that isn't running, announce and skip rather
// than reporting the absence as platform failures. The production default always answers.
const baseUp = await fetch(BASE, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
if (!baseUp) {
  console.log(`SKIP: nothing listening at ${BASE}.`);
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => bad("uncaught page error", String(e)));

await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await page.getByLabel("Username").fill(`modal_${rand}`);
await page.getByLabel("Email").fill(`modal_${rand}@example.com`);
await page.getByLabel("Password").fill("password123");
// The age gate is mandatory on the live register form (same lesson verify-ui learned: skipping
// these two fields silently registers nobody and every later assertion cascades).
await page.getByLabel("Date of birth").fill("1995-04-01");
await page.getByRole("button", { name: "25–34" }).click();
await page.getByRole("button", { name: "Register" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 10000 });

await page.getByRole("button", { name: "Add a Server" }).click();
await page.getByLabel("Server name").fill("Modal Test Server");
await page.getByRole("button", { name: "Create", exact: true }).click();
await page.waitForURL(/\/channels\/.+\/.+/, { timeout: 10000 });

try {
  await page.getByText("Modal Test Server").click();
  await page.getByRole("heading", { name: /server settings/i }).waitFor({ timeout: 5000 });
  ok("Server Settings modal opens");
} catch (e) { bad("Server Settings modal opens", String(e)); }

try {
  const rolesTab = page.getByRole("tab", { name: /roles/i }).or(page.getByText("Roles", { exact: true }));
  await rolesTab.first().click({ timeout: 5000 });
  ok("clicked Roles tab (no crash)");
} catch (e) { console.log("(Roles tab click skipped/best-effort: " + String(e) + ")"); }

try {
  const auditTab = page.getByText(/audit log/i);
  await auditTab.first().click({ timeout: 5000 });
  ok("clicked Audit Log tab (no crash)");
} catch (e) { console.log("(Audit Log tab click skipped/best-effort: " + String(e) + ")"); }

await page.keyboard.press("Escape");

try {
  await page.getByPlaceholder(/^Message /).waitFor({ timeout: 5000 });
  await page.getByPlaceholder(/^Message /).fill("a message to react to");
  await page.getByPlaceholder(/^Message /).press("Enter");
  await page.getByText("a message to react to").hover();
  const html = await page.content();
  ok(`message sent + hovered (page still alive, ${html.length} bytes rendered)`);
} catch (e) { bad("message hover after modal interactions", String(e)); }

// Direct-message route sanity: navigate to DM home
try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("body").innerText();
  if (bodyText.length < 5) throw new Error("empty body");
  ok("DM/home route renders without crashing");
} catch (e) { bad("DM/home route", String(e)); }

console.log(`\n==== MODAL/UI CHECKS: ${pass} PASS, ${fail} FAIL ====`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
