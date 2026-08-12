// Verifies the email-verification UI: an unverified account is TOLD it is unverified, and the
// "Resend" button that VerifyEmailRoute's expired-link copy points at actually exists. The backend
// route shipped with nothing calling it — the copy promised a button that was never built.

import { chromium } from "playwright";
const BASE = "https://lumina.luxffa.com";
const u = `qq_ver_${Date.now()}`;
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
p.on("pageerror", (e) => bad("page error", String(e)));

await p.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await p.getByLabel("Username").fill(u);
await p.getByLabel("Email").fill(`${u}@example.com`);
await p.getByLabel("Password").fill("password123");
await p.getByLabel("Date of birth").fill("1995-04-01");
await p.getByRole("button", { name: "25–34" }).click();
await p.getByRole("button", { name: "Register" }).click();
await p.waitForURL((x) => !x.pathname.startsWith("/register"), { timeout: 15000 });
ok("registered a fresh (therefore unverified) account");

// Open settings via the mobile-independent path: the Profile entry in the bottom nav is hidden on
// desktop, so use the user area button.
await p.goto(`${BASE}/friends`, { waitUntil: "networkidle" });
await p.getByRole("button", { name: /settings/i }).first().click().catch(() => {});
let dialog = p.locator("[role='dialog']").first();
if (!(await dialog.isVisible().catch(() => false))) {
  // Fall back to whatever opens user settings in this build.
  await p.getByLabel(/user settings|account/i).first().click().catch(() => {});
  dialog = p.locator("[role='dialog']").first();
}
try {
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  ok("user settings opened");
} catch (e) { bad("open user settings", String(e)); }

const notVerified = dialog.getByText("Email not verified", { exact: false });
if (await notVerified.isVisible().catch(() => false)) ok("unverified state is shown in My Account");
else bad("no 'Email not verified' row for a brand-new account");

const btn = dialog.getByRole("button", { name: /resend verification email/i });
if (await btn.isVisible().catch(() => false)) {
  ok("the Resend button VerifyEmailRoute points at now exists");
  if (await btn.isEnabled()) ok("Resend button is enabled");
  else bad("Resend button is disabled");
} else bad("Resend button missing");

// Deliberately NOT clicked: the test address is @example.com, which has no MX. Sending to it would
// produce a hard bounce against a young sending domain for no verification value.
const r = await p.evaluate(async (base) => {
  const res = await fetch(`${base}/api/auth/verify-email/resend`, { method: "POST" });
  return res.status;
}, BASE);
if (r === 401) ok("resend route rejects an unauthenticated call (401)");
else bad(`resend route returned ${r} unauthenticated, expected 401`);

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail === 0 ? 0 : 1);
