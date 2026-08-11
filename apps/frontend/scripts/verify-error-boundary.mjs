// Proves the error boundary actually catches a React crash, and that the crash hook used to prove
// it never reaches a shipped build.
//
// An untested error boundary is close to worthless: it fails by silently not catching — wrong
// position in the tree, or an error thrown somewhere boundaries don't apply — and you find that out
// during the incident it existed to soften. So this drives a real render crash in a real browser
// and asserts on what the user would actually see.
//
// Runs against the Vite dev server, because the crash route is dev-only by construction. The last
// check closes that loop from the other side: the production bundle must not contain it.
//
// Usage: node apps/frontend/scripts/verify-error-boundary.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FRONTEND = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:4000";
const REPO = "/home/lucid/lumina";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  // ---- the built artefacts must NOT contain the crash hook --------------------------------
  // Checked first and independently of the browser half: this is the assertion that makes the
  // dev-only test hook safe to keep in the tree at all.
  const { CRASH_MARKER } = await import("../src/components/common/CrashTest.tsx").catch(() => ({
    CRASH_MARKER: "lumina-crash-test-component",
  }));
  for (const dir of ["dist", "dist-owner", "dist-desktop"]) {
    const full = path.join(REPO, "apps/frontend", dir);
    if (!fs.existsSync(full)) continue;
    // grep exits 1 on "no matches", which is the PASS case here — so a plain execFileSync would
    // throw on success. Only a non-1 exit is a real failure to look at the files at all.
    let hits = "";
    try {
      hits = execFileSync("grep", ["-rl", CRASH_MARKER, full], { encoding: "utf8" }).trim();
    } catch (e) {
      if (e.status !== 1) {
        bad(`could not scan ${dir}/ for crash-test code: ${e.message.split("\n")[0]}`);
        continue;
      }
    }
    if (!hits) ok(`${dir}/ contains no crash-test code`);
    else bad(`${dir}/ SHIPS the crash test: ${hits.split("\n").join(", ")}`);
  }

  // ---- drive a real crash in a real browser ------------------------------------------------
  let vite;
  const alreadyRunning = await waitForServer(FRONTEND, 1500);
  if (!alreadyRunning) {
    vite = spawn("npm", ["run", "dev"], {
      cwd: path.join(REPO, "apps/frontend"),
      stdio: "ignore",
      detached: true,
    });
    if (!(await waitForServer(FRONTEND, 60000))) {
      bad("the Vite dev server never came up; cannot exercise the boundary");
      return finish(vite);
    }
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const username = `veb_${Date.now()}`;

  try {
    // A real session: the crash route lives inside AppShell, behind RequireAuth.
    const reg = await fetch(`${API}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        password: "verify-boundary-pw-1",
        ageBracket: "AGE_25_34",
        birthDate: "1995-04-01",
      }),
    });
    if (reg.status !== 201) {
      bad(`could not register a test user (${reg.status})`);
      return finish(vite, browser);
    }

    await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email or Username").fill(username);
    await page.getByLabel("Password").fill("verify-boundary-pw-1");
    await page.getByRole("button", { name: "Log In" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

    await page.goto(`${FRONTEND}/__boom`, { waitUntil: "domcontentloaded" });

    // Vite's dev overlay renders its own error UI on top. It is a separate element and does not
    // replace the React tree underneath, so the boundary's own output is still assertable — but it
    // has to be dismissed first or it swallows the clicks below.
    await page.evaluate(() => document.querySelector("vite-error-overlay")?.remove());

    const alert = page.getByRole("alert");
    await alert.waitFor({ state: "visible", timeout: 15000 });
    ok("a thrown render is caught and something is shown instead of a blank screen");

    if (await alert.getByText(/stopped working/i).isVisible()) ok("the fallback explains what happened");
    else bad("the fallback rendered without an explanation");

    if (await alert.getByRole("button", { name: "Reload" }).isVisible()) ok("the fallback offers a way out");
    else bad("the fallback offers no action — a dead end is barely better than a blank screen");

    // The detail is the difference between a bug report that says "it broke" and one that can be
    // acted on. It matters most on Android, where the console goes to logcat and is unreachable.
    await alert.getByText("Technical details").click();
    const detail = await alert.locator("pre").innerText();
    if (detail.includes("Deliberate crash")) ok("the real error message is recoverable from the UI");
    else bad(`the details pane does not carry the error (got: ${detail.slice(0, 80)})`);

    // The rail must have SURVIVED — the entire reason this boundary sits inside AppShell rather
    // than around it. Asserted geometrically rather than by selector: the rail carries no landmark
    // role or aria-label to target, but it occupies the left edge, so a fallback that begins at
    // x > 0 proves something is still laid out beside it. Had the root boundary caught this
    // instead, the fallback would span the viewport from x = 0.
    const box = await alert.boundingBox();
    const viewport = page.viewportSize();
    if (box && box.x > 0) {
      ok(`the app shell survived the crash (fallback starts at x=${Math.round(box.x)}, not the viewport edge)`);
    } else if (box && viewport && box.width >= viewport.width) {
      bad("the fallback spans the whole viewport — the crash was caught by the ROOT boundary, taking navigation with it");
    } else {
      bad(`could not establish that the shell survived (box=${JSON.stringify(box)})`);
    }

    // And it must RESET on navigating away, or the boundary latches and every later page is broken.
    await page.goto(`${FRONTEND}/friends`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const stillBroken = await page.getByRole("alert").isVisible().catch(() => false);
    if (!stillBroken) ok("navigating away clears the error instead of latching forever");
    else bad("the boundary stayed in its error state after navigating away");
  } catch (e) {
    bad(`error boundary: ${e.message?.split("\n")[0] ?? e}`);
  } finally {
    await browser.close().catch(() => {});
    try {
      execFileSync("docker", [
        "compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc",
        `delete from "User" where username = '${username}';`,
      ], { cwd: REPO, stdio: "ignore" });
    } catch {
      /* the throwaway account is harmless if cleanup fails */
    }
  }

  finish(vite);
}

function finish(vite) {
  // Killed by process group: `npm run dev` spawns vite as a child, and killing only npm leaves the
  // server holding port 5173 for every later run.
  if (vite?.pid) {
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
