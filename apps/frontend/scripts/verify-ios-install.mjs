// Verifies the iPhone install path: the manifest iOS requires, and the hint that tells people the
// app can be installed at all.
//
// Safari offers no install prompt and no API to trigger one, so on iOS this hint is the entire
// discovery mechanism — and since iOS 16.4 a home-screen web app is the only way an iPhone can
// receive Web Push. If it silently stops rendering, push on iOS becomes unreachable with nothing
// to indicate why.
import { chromium, devices } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
let pass = 0, fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const HINT = "Install Lumina on your iPhone";

async function main() {
  // ---- the manifest itself ----------------------------------------------------------------
  const res = await fetch(`${BASE}/manifest.webmanifest`, { cache: "no-store" });
  const contentType = res.headers.get("content-type") ?? "";
  if (res.ok) ok(`the manifest is served (${res.status})`);
  else bad(`the manifest returned ${res.status} — iOS cannot install the app`);

  // nginx's bundled mime.types has no .webmanifest entry, so this silently degrades to
  // application/octet-stream unless explicitly set. Safari is among the stricter consumers.
  if (contentType.includes("application/manifest+json")) ok(`served as ${contentType}`);
  else bad(`served as "${contentType}" — should be application/manifest+json`);

  const manifest = await res.json();
  for (const key of ["name", "short_name", "start_url", "display", "icons"]) {
    if (manifest[key]) ok(`manifest has ${key}`);
    else bad(`manifest is missing ${key} — iOS will not treat it as installable`);
  }
  if (manifest.display === "standalone") ok("display is standalone, so it opens without the browser bar");
  else bad(`display is "${manifest.display}" — the installed app would still show Safari chrome`);

  // A manifest naming an icon that 404s produces a blank home-screen tile.
  for (const icon of manifest.icons ?? []) {
    const head = await fetch(new URL(icon.src, BASE), { method: "HEAD" });
    if (head.ok) ok(`icon ${icon.sizes} ${icon.purpose ?? "any"} exists`);
    else bad(`icon ${icon.src} returned ${head.status} — the home-screen tile would be blank`);
  }

  const html = await (await fetch(`${BASE}/index.html`, { cache: "no-store" })).text();
  if (/rel="manifest"/.test(html)) ok("index.html links the manifest");
  else bad("index.html does not link the manifest");
  // Without viewport-fit=cover every env(safe-area-inset-*) reads zero, and the installed app
  // draws its header under the notch.
  if (/viewport-fit=cover/.test(html)) ok("viewport-fit=cover is set, so safe-area insets are real");
  else bad("viewport-fit=cover is missing — an installed app would draw under the notch");

  // ---- the hint, in a real browser ---------------------------------------------------------
  const browser = await chromium.launch();
  const created = [];

  async function withSession(label, contextOptions, expectHint, { standalone = false } = {}) {
    const ctx = await browser.newContext(contextOptions);
    const page = await ctx.newPage();
    if (standalone) {
      // The real signal iOS sets on a home-screen app. Playwright has no device option for it, and
      // an "already installed" case that does not actually set it is a test that asserts nothing —
      // it passed only because it was told to expect the hint. Injected before any page script runs
      // so the app sees it at first render.
      await page.addInitScript(() => {
        Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
      });
    }
    const username = `iosv_${Date.now()}${Math.floor(Math.random() * 1000)}`;
    try {
      await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Username").fill(username);
      await page.getByLabel("Email").fill(`${username}@example.com`);
      await page.getByLabel("Password").fill("ios-verify-pw-1");
      await page.getByLabel("Date of birth").fill("1995-04-01");
      await page.getByRole("button", { name: "25–34" }).click();
      await page.getByRole("button", { name: "Register" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 25000 });
      created.push(username);

      // Waiting for the element rather than polling isVisible() straight after the URL changes.
      // The naive version passes or fails depending on render timing and reported this working
      // feature as broken once already.
      const locator = page.getByText(HINT);
      if (expectHint) {
        await locator.waitFor({ state: "visible", timeout: 15000 });
        ok(`${label}: the install hint is shown`);
        if (await page.getByText("Add to Home Screen").isVisible()) {
          ok(`${label}: it says how, not just that`);
        } else {
          bad(`${label}: the hint gives no instructions`);
        }
      } else {
        await page.waitForTimeout(3000);
        if ((await locator.count()) === 0) ok(`${label}: correctly shows nothing`);
        else bad(`${label}: the iPhone install hint appeared where it cannot be followed`);
      }
    } catch (e) {
      bad(`${label}: ${e.message.split("\n")[0]}`);
    } finally {
      await ctx.close();
    }
  }

  const iPhone = devices["iPhone 13"];
  await withSession("iPhone Safari", iPhone, true);
  await withSession("Desktop Chrome", {}, false);
  // Chrome/Firefox on iOS cannot Add to Home Screen at all, so showing them the advice would be
  // telling users to do something their browser does not offer.
  await withSession("Chrome on iOS", {
    ...iPhone,
    userAgent: iPhone.userAgent.replace("Version/", "CriOS/120.0 Version/"),
  }, false);
  // An already-installed app must not keep nagging about installing.
  await withSession("iPhone, already installed", iPhone, false, { standalone: true });

  await browser.close();

  // Servers are auto-created for new accounts, and the FK means the user cannot be deleted while
  // one exists — so the owned rows go first, by exact id, never a blind cascade.
  if (created.length) {
    const list = created.map((u) => `'${u}'`).join(",");
    execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-c",
      `DELETE FROM "Server" WHERE "ownerId" IN (SELECT id FROM "User" WHERE username IN (${list}));
       DELETE FROM "User" WHERE username IN (${list});`],
      { cwd: REPO, stdio: "ignore" });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
