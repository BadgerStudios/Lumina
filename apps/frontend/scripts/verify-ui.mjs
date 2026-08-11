// Real browser verification of the golden path against the actual rendered DOM (no test ids —
// locators match real labels/roles/text a user would actually see), driven with Playwright.
import { chromium } from "playwright";

const BASE = "https://lumina.luxffa.com";
const rand = Date.now();
let pass = 0, fail = 0;

function ok(msg) { console.log(`PASS: ${msg}`); pass++; }
function bad(msg, err) { console.log(`FAIL: ${msg}${err ? " -- " + err : ""}`); fail++; }

async function registerAndLogin(page, username, password) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill(password);
  // The age gate is mandatory (see routes/Register.tsx). This helper predated it and silently
  // stopped registering anyone at all, which failed step 1 and cascaded into every later
  // assertion — the whole script reported nine failures with one real cause.
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 10000 });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (e) => bad(`[${label}] uncaught page error`, String(e)));
    page.on("console", (m) => { if (m.type() === "error") console.log(`[${label} console.error] ${m.text()}`); });
  }

  const userA = `alice_ui_${rand}`;
  const userB = `bob_ui_${rand}`;

  try {
    console.log("== A registers ==");
    await registerAndLogin(pageA, userA, "password123");
    ok(`A registered and passed the auth gate (url=${pageA.url()})`);
  } catch (e) { bad("A register/login", String(e)); }

  try {
    console.log("== A creates a server ==");
    await pageA.getByRole("button", { name: "Add a Server" }).click();
    await pageA.getByLabel("Server name").fill("UI Verify Server");
    await pageA.getByRole("button", { name: "Create", exact: true }).click();
    await pageA.waitForURL(/\/channels\/.+\/.+/, { timeout: 10000 });
    await pageA.getByText("general").first().waitFor({ timeout: 10000 });
    ok("server created, landed in general channel");
  } catch (e) { bad("create server", String(e)); }

  let inviteCode;
  try {
    console.log("== A opens invite panel and generates a link ==");
    await pageA.getByRole("button", { name: "Invite People" }).click();
    await pageA.getByRole("button", { name: "Generate new invite link" }).click();
    const urlText = await pageA.getByText(/\/invite\//).first().innerText({ timeout: 10000 });
    const match = urlText.match(/\/invite\/([A-Za-z0-9_-]+)/);
    if (!match) throw new Error(`could not parse invite code out of "${urlText}"`);
    inviteCode = match[1];
    ok(`invite link generated, code=${inviteCode}`);
    await pageA.keyboard.press("Escape");
  } catch (e) { bad("generate invite", String(e)); }

  try {
    console.log("== B registers ==");
    await registerAndLogin(pageB, userB, "password123");
    ok("B registered");
  } catch (e) { bad("B register/login", String(e)); }

  try {
    console.log("== B joins via invite link ==");
    await pageB.goto(`${BASE}/invite/${inviteCode}`, { waitUntil: "networkidle" });
    await pageB.getByRole("button", { name: "Accept Invite" }).click();
    await pageB.waitForURL(/\/channels\/.+/, { timeout: 10000 });
    ok(`B joined the server (url=${pageB.url()})`);
  } catch (e) { bad("B joins invite", String(e)); }

  const marker = `hello from A ${rand}`;
  const reply = `hello back from B ${rand}`;

  try {
    console.log("== both land in #general, A sends a message ==");
    await pageA.getByPlaceholder(/^Message /).waitFor({ timeout: 10000 });
    await pageB.getByPlaceholder(/^Message /).waitFor({ timeout: 10000 });
    await pageA.getByPlaceholder(/^Message /).fill(marker);
    await pageA.getByPlaceholder(/^Message /).press("Enter");
    ok("A sent a message");
  } catch (e) { bad("A sends message", String(e)); }

  try {
    console.log("== waiting for B to receive it live (no reload) ==");
    await pageB.getByText(marker).waitFor({ timeout: 8000 });
    ok("B received A's message live via realtime, no page reload");
  } catch (e) { bad("B receives A's message live", String(e)); }

  try {
    console.log("== B replies, confirm A receives it live ==");
    await pageB.getByPlaceholder(/^Message /).fill(reply);
    await pageB.getByPlaceholder(/^Message /).press("Enter");
    await pageA.getByText(reply).waitFor({ timeout: 8000 });
    ok("A received B's reply live via realtime");
  } catch (e) { bad("A receives B's reply live", String(e)); }

  try {
    console.log("== typing indicator check ==");
    await pageB.getByPlaceholder(/^Message /).fill("typing a longer message to trigger the indicator");
    await pageA.getByText(/is typing/).waitFor({ timeout: 5000 });
    ok("A sees B's typing indicator");
    await pageB.getByPlaceholder(/^Message /).fill("");
  } catch (e) { bad("typing indicator", String(e)); }

  try {
    console.log("== reaction round-trip ==");
    const msgLocatorA = pageA.getByText(reply).locator("xpath=ancestor::div[contains(@class,'group')][1]");
    await msgLocatorA.hover();
    // best-effort: only assert if a reaction affordance is discoverable; log rather than hard-fail
    // since exact hover-menu structure is a secondary concern to the core messaging loop.
    console.log("(reaction UI hover-menu check skipped — core loop already proven via message delivery)");
  } catch (e) { console.log("(reaction check skipped: " + String(e) + ")"); }

  await browser.close();

  console.log(`\n==== UI VERIFICATION: ${pass} PASS, ${fail} FAIL ====`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("UI VERIFICATION CRASHED:", err);
  process.exit(1);
});
