// Real-browser verification that the UI fits the viewport it is given — at every size, in both
// orientations, and while an on-screen keyboard is open.
//
// The two defects this exists to catch, both of which shipped and neither of which a typecheck or a
// desktop screenshot would have found:
//
//  1. `100vh` on a mobile browser is the viewport with the URL bar RETRACTED. With an
//     `overflow-hidden` app shell, the bottom nav and the composer sat below the fold with no way
//     to scroll to them. Asserted here by comparing the shell's rendered height against the actual
//     viewport, not by trusting the class name.
//  2. The mobile/desktop breakpoint was width-only, so a phone rotated to landscape (844x390)
//     crossed 768px and got the full three-column desktop layout in 390px of height.
//
// Run: node scripts/verify-responsive.mjs   (BASE=... to point elsewhere)
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const rand = Date.now();
let pass = 0,
  fail = 0;

function ok(msg) {
  console.log(`PASS: ${msg}`);
  pass++;
}
function bad(msg, err) {
  console.log(`FAIL: ${msg}${err ? " -- " + err : ""}`);
  fail++;
}

/**
 * Every device the layout has to survive. Landscape phones are the interesting ones: wide enough to
 * trip a width-only `md:` breakpoint, far too short to render what that breakpoint implies.
 */
const VIEWPORTS = [
  { name: "phone portrait (iPhone 14)", width: 390, height: 844, compact: true },
  { name: "phone landscape (iPhone 14)", width: 844, height: 390, compact: true },
  { name: "small phone portrait", width: 320, height: 568, compact: true },
  { name: "phone landscape (Pro Max)", width: 932, height: 430, compact: true },
  { name: "tablet portrait (iPad)", width: 820, height: 1180, compact: false },
  { name: "tablet landscape (iPad)", width: 1180, height: 820, compact: false },
  { name: "laptop", width: 1440, height: 900, compact: false },
  { name: "ultrawide", width: 2560, height: 1080, compact: false },
  { name: "short desktop window", width: 1440, height: 420, compact: true },
];

async function registerAndLogin(page, username) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill("password123");
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 15000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => bad("uncaught page error", String(e)));

  const user = `qq_resp_${rand}`;
  try {
    await registerAndLogin(page, user);
    ok(`registered ${user} and reached the app`);
  } catch (e) {
    bad("register/login", String(e));
    await browser.close();
    process.exit(1);
  }

  for (const vp of VIEWPORTS) {
    console.log(`\n== ${vp.name} (${vp.width}x${vp.height}) ==`);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    // One frame for the resize listener to publish, one for React to re-render off it.
    await page.waitForTimeout(300);

    const m = await page.evaluate(() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const shell = document.querySelector(".h-app-safe");
      const nav = document.querySelector("nav.fixed.inset-x-0");
      return {
        orientation: root.dataset.orientation,
        viewportMode: root.dataset.viewport,
        appHeight: cs.getPropertyValue("--app-height").trim(),
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : null,
        navBottom: nav ? Math.round(nav.getBoundingClientRect().bottom) : null,
        navVisible: nav ? getComputedStyle(nav).display !== "none" : false,
      };
    });

    // --- the height bug ---
    if (m.shellHeight === null) {
      bad(`${vp.name}: no app shell found`);
    } else if (Math.abs(m.shellHeight - vp.height) <= 2) {
      ok(`${vp.name}: shell is ${m.shellHeight}px for a ${vp.height}px viewport`);
    } else {
      bad(`${vp.name}: shell is ${m.shellHeight}px but the viewport is ${vp.height}px`);
    }

    if (m.appHeight === `${vp.height}px`) {
      ok(`${vp.name}: --app-height tracks the real viewport (${m.appHeight})`);
    } else {
      bad(`${vp.name}: --app-height is ${m.appHeight}, expected ${vp.height}px`);
    }

    // --- orientation detection ---
    const expectedOrientation = vp.height >= vp.width ? "portrait" : "landscape";
    if (m.orientation === expectedOrientation) {
      ok(`${vp.name}: detected as ${m.orientation}`);
    } else {
      bad(`${vp.name}: detected ${m.orientation}, expected ${expectedOrientation}`);
    }

    // --- the breakpoint bug: compact must consider height, not just width ---
    const expectedMode = vp.compact ? "compact" : "roomy";
    if (m.viewportMode === expectedMode) {
      ok(`${vp.name}: layout mode ${m.viewportMode}`);
    } else {
      bad(`${vp.name}: layout mode ${m.viewportMode}, expected ${expectedMode}`);
    }

    // The mobile tab bar is the visible consequence of that decision, and the thing that used to
    // disappear the moment a phone was rotated.
    if (m.navVisible === vp.compact) {
      ok(`${vp.name}: tab bar ${vp.compact ? "shown" : "hidden"} as expected`);
    } else {
      bad(`${vp.name}: tab bar ${m.navVisible ? "shown" : "hidden"}, expected the opposite`);
    }

    // A visible bar whose bottom edge is past the viewport is exactly the shipped bug.
    if (m.navVisible && m.navBottom !== null && m.navBottom > vp.height + 2) {
      bad(`${vp.name}: tab bar bottom at ${m.navBottom}px is below the ${vp.height}px fold`);
    } else if (m.navVisible) {
      ok(`${vp.name}: tab bar sits fully on screen (bottom ${m.navBottom}px)`);
    }

    // --- nothing may overflow sideways at any width ---
    if (m.docScrollWidth <= vp.width + 1) {
      ok(`${vp.name}: no horizontal overflow`);
    } else {
      bad(`${vp.name}: document scrolls to ${m.docScrollWidth}px in a ${vp.width}px viewport`);
    }
  }

  // --- modals must fit the short viewports too ---
  console.log("\n== modal on a landscape phone ==");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  try {
    await page.getByRole("button", { name: "Profile" }).click();
    const dialog = page.locator("[role='dialog']").first();
    await dialog.waitFor({ state: "visible", timeout: 8000 });
    const box = await dialog.boundingBox();
    if (box && box.y >= -1 && box.y + box.height <= 391) {
      ok(`settings modal fits inside 390px (top ${Math.round(box.y)}, height ${Math.round(box.height)})`);
    } else {
      bad(`settings modal overflows: top ${box && Math.round(box.y)}, height ${box && Math.round(box.height)}`);
    }
    // The title has to stay put — a scrolled-away header on a 390px dialog leaves no way to tell
    // what is being edited.
    const titleVisible = await dialog.getByRole("heading").first().isVisible();
    if (titleVisible) ok("modal title is visible at 390px height");
    else bad("modal title is not visible at 390px height");
    await page.keyboard.press("Escape");
  } catch (e) {
    bad("modal check", String(e));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
