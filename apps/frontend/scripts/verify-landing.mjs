// Browser verification of the public landing page and the move of the app to /app.
//
// The risk in this change is not whether the page renders — it's whether moving the app off `/`
// quietly broke the ways people already reach it. So most of these assertions are about the app
// still working: signed-in users landing in the app rather than on marketing, deep links surviving,
// and the download links actually resolving to files rather than to the SPA's index.html.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-landing-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

async function register(username) {
  const res = await fetch(`${BASE}/api/auth/register`, {
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
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
}

async function main() {
  const user = `vl_${rand}`;
  await register(user);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => bad("uncaught page error", String(e)));

  try {
    // --- Logged out: the landing page ------------------------------------------------------
    await page.goto(BASE, { waitUntil: "networkidle" });
    if (page.url().replace(/\/$/, "") === BASE.replace(/\/$/, "")) ok("logged-out visitor stays on /");
    else bad(`logged-out visitor was redirected to ${page.url()}`);

    for (const [what, locator] of [
      ["headline", page.getByRole("heading", { level: 1 })],
      ["primary call to action", page.getByRole("link", { name: /create your account/i })],
      ["sign-in link", page.getByRole("link", { name: /^sign in$/i }).first()],
      ["features section", page.getByRole("heading", { name: /everything a community needs/i })],
      ["apps section", page.getByRole("heading", { name: /wherever you already are/i })],
    ]) {
      if (await locator.first().isVisible().catch(() => false)) ok(`landing renders its ${what}`);
      else bad(`landing is missing its ${what}`);
    }

    // A marketing page that scrolls sideways on a phone looks broken regardless of the design.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (!overflows) ok("no horizontal overflow at 390px wide");
    else bad("page scrolls horizontally on a phone-sized viewport");
    await page.setViewportSize({ width: 1280, height: 900 });

    // The whole point of the page is these links working.
    for (const [name, path] of [
      ["Android APK", "/downloads/lumina.apk"],
      ["desktop AppImage", "/downloads/lumina-desktop.AppImage"],
    ]) {
      const res = await page.request.head(`${BASE}${path}`);
      const type = res.headers()["content-type"] ?? "";
      // An SPA fallback would return 200 with text/html — a 200 alone proves nothing here.
      if (res.ok() && !type.includes("text/html")) ok(`${name} download resolves (${type || "no type"})`);
      else bad(`${name} download returned ${res.status()} ${type}`);
    }

    // --- Signed in: the app ----------------------------------------------------------------
    await page.getByRole("link", { name: /^sign in$/i }).first().click();
    await page.waitForURL(/\/login/, { timeout: 15000 });
    await page.getByLabel(/email or username/i).fill(user);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^(sign in|log in)$/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
    ok(`signed in, landed on ${new URL(page.url()).pathname}`);

    // A signed-in person hitting the root must get the app, not a pitch for it.
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (new URL(page.url()).pathname === "/app") ok("signed-in visitor at / is redirected to /app");
    else bad(`signed-in visitor at / stayed on ${new URL(page.url()).pathname}`);

    if ((await page.getByRole("heading", { name: /everything a community needs/i }).count()) === 0) {
      ok("marketing content is not shown to a signed-in user");
    } else {
      bad("signed-in user was shown the landing page");
    }

    // Deep links are what break silently when a root route moves.
    for (const path of ["/app", "/friends", "/foryou"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      const landed = new URL(page.url()).pathname;
      if (landed === path) ok(`deep link ${path} still resolves`);
      else bad(`deep link ${path} landed on ${landed}`);
    }
  } catch (e) {
    bad("landing flow", String(e));
    await page.screenshot({ path: "/tmp/verify-landing-failure.png", fullPage: true }).catch(() => {});
    console.log("screenshot: /tmp/verify-landing-failure.png");
  } finally {
    await browser.close();
    sql(`delete from "User" where username = '${user}';`);
    console.log(`cleaned up ${user}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
