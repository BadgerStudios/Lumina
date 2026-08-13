// Verifies the mobile-mode JS bundle's auth/realtime logic the way a Capacitor WebView would
// actually exercise it: served from an origin that is NOT lumina.luxffa.com (so no cookie could
// possibly be shared, exactly like capacitor://localhost), talking to the live public backend
// over absolute URLs, using X-Client-Type: mobile + a body/on-device-stored refresh token
// instead of the web cookie flow. This is the part a bare "does the APK build" check can't
// prove — that the bundled auth code path actually works, not just compiles.
import { chromium } from "playwright";

const APP_ORIGIN = "http://127.0.0.1:5175"; // stand-in for capacitor://localhost
const API_ORIGIN = "https://lumina.luxffa.com";
const rand = Date.now();
let pass = 0, fail = 0;
function ok(m) { console.log("PASS: " + m); pass++; }
function bad(m, e) { console.log("FAIL: " + m + (e ? " -- " + e : "")); fail++; }

// --disable-web-security: the real Capacitor origin (capacitor://localhost / https://localhost)
// is on the backend's CORS_ORIGIN allowlist, but this stand-in (127.0.0.1:5175) deliberately
// isn't — and shouldn't be added there just to make a local script pass. Bypassing CORS here
// only removes that origin-matching artifact from *this test*; it doesn't touch the server
// config, so a passing run still means "the mobile auth code path works," not "CORS is open."
// The WebView stand-in: an origin that serves the MOBILE-MODE bundle but is not the API's
// origin, reproducing capacitor://localhost's no-shared-cookie-jar situation. Originally this
// required starting a dev server by hand; now the suite is self-sufficient for the production
// battery — if nothing is listening it builds the mobile bundle itself and serves it statically.
import { execSync } from "node:child_process";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

let standInServer = null;
const appUp = await fetch(APP_ORIGIN, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
if (!appUp) {
  const outDir = "dist-verify-mobile";
  console.log("(building the mobile-mode bundle for the stand-in origin — one-off, ~a minute)");
  execSync(`npx vite build --mode mobile --outDir ${outDir} --logLevel error`, { stdio: "inherit" });
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
  standInServer = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    let file = join(outDir, path === "/" ? "index.html" : path.slice(1));
    if (!existsSync(file)) file = join(outDir, "index.html"); // SPA fallback
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => standInServer.listen(5175, "127.0.0.1", resolve));
  console.log(`(stand-in serving ${outDir} at ${APP_ORIGIN})`);
}

const browser = await chromium.launch({ headless: true, args: ["--disable-web-security"] });
const context = await browser.newContext();
const page = await context.newPage();

const mobileHeaderSeen = { register: false, refresh: false };
page.on("request", (req) => {
  const url = req.url();
  const h = req.headers()["x-client-type"];
  if (url.includes("/auth/register") && h === "mobile") mobileHeaderSeen.register = true;
  if (url.includes("/auth/refresh") && h === "mobile") mobileHeaderSeen.refresh = true;
});
page.on("pageerror", (e) => bad("uncaught page error", String(e)));

await page.goto(APP_ORIGIN, { waitUntil: "networkidle" });

// Confirm no cookies exist for the API origin at all (proves the flow can't be relying on one).
const apiCookiesBefore = await context.cookies(API_ORIGIN);
if (apiCookiesBefore.length === 0) ok(`zero cookies for ${API_ORIGIN} before auth (as expected in a WebView)`);
else bad(`unexpected cookies present for ${API_ORIGIN}`, JSON.stringify(apiCookiesBefore));

try {
  // Note: navigate via the app's own client-side router (goto root, click the Register link)
  // rather than loading /register directly — a bare static file server has no SPA fallback
  // (unlike the real nginx/Vite deployments, which do), so a direct deep-link 404s here.
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`mobile_${rand}`);
  await page.getByLabel("Email").fill(`mobile_${rand}@example.com`);
  await page.getByLabel("Password").fill("password123");
  // Age is mandatory at signup now, so the UI flow has to answer it like a real person would.
  await page.getByRole("button", { name: "18–24" }).click().catch(() => {});
  await page.locator('input[type="date"]').fill("1998-05-20").catch(() => {});
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 10000 });
  ok("registered via mobile bundle against the live public backend");
} catch (e) { bad("mobile register", String(e)); }

if (mobileHeaderSeen.register) ok("X-Client-Type: mobile header was sent on /auth/register");
else bad("X-Client-Type: mobile header NOT observed on /auth/register");

const apiCookiesAfter = await context.cookies(API_ORIGIN);
if (apiCookiesAfter.length === 0) ok("still zero cookies for the API origin after login (refresh token is NOT cookie-based here)");
else bad("a cookie was set for the API origin — mobile flow should never rely on cookies", JSON.stringify(apiCookiesAfter));

const storedToken = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});
const hasRefreshTokenStored = Object.entries(storedToken).some(([k, v]) => /refresh/i.test(k) && v && v.length > 10);
if (hasRefreshTokenStored) ok("refresh token persisted on-device (Preferences web-fallback -> localStorage)");
else bad("no on-device refresh token found in storage", JSON.stringify(Object.keys(storedToken)));

// Simulate the app being relaunched: clear only the in-memory access token by doing a hard
// reload (Zustand state is JS-memory-only and wiped on reload, but localStorage survives) —
// this is exactly the "cold start" case a real phone app hits on every launch.
try {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10000 });
  ok("session restored after reload using the stored refresh token (no cookie involved)");
} catch (e) { bad("session restore after reload", String(e)); }

if (mobileHeaderSeen.refresh) ok("X-Client-Type: mobile header was sent on /auth/refresh during restore");
else bad("X-Client-Type: mobile header NOT observed on /auth/refresh");

// Realtime sanity: create a server and confirm the socket (pointed at the absolute
// VITE_SOCKET_URL) actually connects and a sent message round-trips back into the UI.
try {
  await page.getByRole("button", { name: "Add a Server" }).click();
  await page.getByLabel("Server name").fill("Mobile Verify Server");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/channels\/.+\/.+/, { timeout: 10000 });
  await page.getByPlaceholder(/^Message /).waitFor({ timeout: 10000 });
  const marker = `mobile realtime check ${rand}`;
  await page.getByPlaceholder(/^Message /).fill(marker);
  await page.getByPlaceholder(/^Message /).press("Enter");
  await page.getByText(marker).waitFor({ timeout: 8000 });
  ok("socket connected to absolute VITE_SOCKET_URL and a sent message round-tripped back");
} catch (e) { bad("mobile realtime round-trip", String(e)); }

console.log(`\n==== MOBILE BUNDLE VERIFICATION: ${pass} PASS, ${fail} FAIL ====`);
await browser.close();
standInServer?.close();
process.exit(fail > 0 ? 1 : 0);
