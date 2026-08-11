// Verifies a user can actually change their own password through the settings UI.
//
// Written after I told the user to "change it once you're in" without having checked that the path
// worked — the form's labels were <span>s, so the inputs had no accessible name and nothing could
// find them. Asserts against real logins afterwards, since the only proof a password changed is
// that the old one stops working.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const B = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const U = `pwc${Date.now()}`;
const OLD = "OldPassword123!";
const NEW = "NewPassword456!";
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m) => (console.log("FAIL: " + m), fail++);
const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q],
    { cwd: "/home/lucid/lumina", encoding: "utf8" }).trim();

const login = (pw) =>
  fetch(`${B}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername: U, password: pw }) });

await fetch(`${B}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: U, email: `${U}@example.com`, password: OLD, ageBracket: "AGE_25_34", birthDate: "1995-04-01" }) });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => bad("page error: " + e.message));
try {
  await page.goto(`${B}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/email or username/i).fill(U);
  await page.getByLabel(/password/i).fill(OLD);
  await page.getByRole("button", { name: /^(sign in|log in)$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  ok("logged in with the original password");

  await page.getByRole("button", { name: /user settings/i }).first().click();
  await page.getByRole("heading", { name: /my account|account/i }).first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByRole("button", { name: /^change$/i }).last().click();

  // These locators only resolve because the inputs now carry an accessible name.
  await page.getByLabel("Current password", { exact: true }).fill(OLD);
  await page.getByLabel("New password", { exact: true }).fill(NEW);
  await page.getByLabel("Confirm new password", { exact: true }).fill(NEW);
  ok("change-password form is reachable and its fields are labelled");

  await page.getByRole("button", { name: /^save$/i }).first().click();
  await page.getByText(/password updated/i).waitFor({ timeout: 15000 });
  ok("UI reported the password was updated");
} catch (e) {
  bad("flow: " + String(e).slice(0, 200));
  await page.screenshot({ path: "/tmp/verify-password-change.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const withNew = await login(NEW);
const withOld = await login(OLD);
withNew.status === 200 ? ok("new password works") : bad(`new password returned ${withNew.status}`);
withOld.status === 401 ? ok("old password no longer works") : bad(`old password still returned ${withOld.status}`);

sql(`delete from "User" where username='${U}';`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
