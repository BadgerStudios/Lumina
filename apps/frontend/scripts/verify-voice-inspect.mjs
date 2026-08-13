// Live verification of the mic-mode gate (push-to-talk / voice activity) and the inspect
// deterrent, against the real deployment.
//
// The gate assertions deliberately drive the REAL voice path — register, make a server, join an
// actual voice channel — rather than poking at a store in isolation. The whole point of the
// feature is whether audio is leaving the machine, and that is decided by `track.enabled` on a
// live getUserMedia stream. A test that stubbed that out would pass against a build that
// transmits constantly.
//
// Chromium's fake media device supplies a mic that emits a steady tone, so voice-activity mode
// sees continuous "speech". That makes VAD's *open* state testable here; the closed state is not
// (there is no silence to fall back to), which is why push-to-talk carries the gate-closed
// assertions — it gates on a keypress rather than on audio.
import { chromium } from "playwright";

const BASE = "https://lumina.badgerstudios.net";
const rand = Date.now();
let pass = 0, fail = 0;

function ok(msg) { console.log(`PASS: ${msg}`); pass++; }
function bad(msg, err) { console.log(`FAIL: ${msg}${err ? " -- " + err : ""}`); fail++; }

async function registerAndLogin(page, username, password) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 15000 });
}

/** Fire an event and report whether the page's own handler called preventDefault on it. */
function probeKey(page, init) {
  return page.evaluate((i) => {
    const e = new KeyboardEvent("keydown", { ...i, bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }, init);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => bad("uncaught page error", String(e)));

  const user = `qq_voice_${rand}`;

  try {
    console.log("== register ==");
    await registerAndLogin(page, user, "password123");
    ok(`registered and past the auth gate (url=${page.url()})`);
  } catch (e) { bad("register", String(e)); }

  // ---------------------------------------------------------------- inspect deterrent
  console.log("== inspect deterrent ==");
  try {
    const prevented = await page.evaluate(() => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    prevented ? ok("right-click is suppressed on the page body") : bad("right-click NOT suppressed on body");
  } catch (e) { bad("contextmenu on body", String(e)); }

  try {
    // Positive control in the other direction: a blanket contextmenu block would break paste in
    // the composer, so the exemption for editable fields has to be asserted, not assumed.
    const prevented = await page.evaluate(() => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      input.dispatchEvent(e);
      input.remove();
      return e.defaultPrevented;
    });
    prevented ? bad("right-click wrongly suppressed inside a text input (breaks paste)")
              : ok("right-click still works inside a text input");
  } catch (e) { bad("contextmenu in input", String(e)); }

  for (const [label, init] of [
    ["F12", { key: "F12", code: "F12" }],
    ["Ctrl+Shift+I", { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Shift+J", { key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true }],
    ["Ctrl+U", { key: "u", code: "KeyU", ctrlKey: true }],
    ["Cmd+Opt+I", { key: "i", code: "KeyI", metaKey: true, altKey: true }],
  ]) {
    try {
      const prevented = await probeKey(page, init);
      prevented ? ok(`${label} is swallowed`) : bad(`${label} is NOT swallowed`);
    } catch (e) { bad(`${label} probe`, String(e)); }
  }

  try {
    // Positive control: if this were also swallowed the guard would be breaking copy/paste, and
    // every assertion above would pass for the wrong reason.
    const prevented = await probeKey(page, { key: "c", code: "KeyC", ctrlKey: true });
    prevented ? bad("Ctrl+C is wrongly swallowed (copy would be broken)") : ok("Ctrl+C still works");
  } catch (e) { bad("Ctrl+C probe", String(e)); }

  // ---------------------------------------------------------------- settings UI
  console.log("== voice settings ==");
  async function openVoiceSettings() {
    await page.getByRole("button", { name: "User Settings" }).click();
    await page.getByRole("button", { name: "Voice & Video" }).click();
  }

  try {
    await openVoiceSettings();
    for (const label of ["Open mic", "Voice activity", "Push to talk"]) {
      await page.getByText(label, { exact: true }).first().waitFor({ timeout: 8000 });
    }
    ok("all three input modes are offered");
  } catch (e) { bad("input modes render", String(e)); }

  try {
    await page.getByText("Voice activity", { exact: true }).first().click();
    await page.getByLabel("Input sensitivity").waitFor({ timeout: 5000 });
    ok("voice activity reveals the sensitivity slider");
    const stored = await page.evaluate(() => window.localStorage.getItem("lumina-mic-mode"));
    stored === "voice" ? ok("mic mode persisted to localStorage") : bad(`mic mode not persisted (got ${stored})`);
  } catch (e) { bad("voice activity mode", String(e)); }

  try {
    await page.getByLabel("Input sensitivity").fill("30");
    const stored = await page.evaluate(() => window.localStorage.getItem("lumina-vad-sensitivity"));
    stored === "30" ? ok("sensitivity persisted to localStorage") : bad(`sensitivity not persisted (got ${stored})`);
  } catch (e) { bad("sensitivity persist", String(e)); }

  try {
    await page.getByText("Push to talk", { exact: true }).first().click();
    await page.getByText("Push to talk", { exact: true }).nth(1).waitFor({ timeout: 5000 });
    ok("push-to-talk reveals its keybind row");
  } catch (e) { bad("ptt keybind row", String(e)); }

  try {
    await page.keyboard.press("Escape");
    ok("settings closed");
  } catch (e) { bad("close settings", String(e)); }

  // ---------------------------------------------------------------- the gate itself
  console.log("== the gate ==");
  try {
    await page.getByRole("button", { name: "Add a Server" }).click();
    await page.getByLabel("Server name").fill("Voice Verify");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/channels\/.+\/.+/, { timeout: 15000 });
    ok("server created");
  } catch (e) { bad("create server", String(e)); }

  try {
    // The default server template ships a "General" voice channel alongside the text one.
    // Case-sensitive exact match: the default text channel is "general", the voice one "General".
    await page.getByText("General", { exact: true }).first().click();
    await page.getByText(/Voice Connected/).waitFor({ timeout: 20000 });
    ok("joined a voice channel");
  } catch (e) { bad("join voice", String(e)); }

  const micButton = () => page.locator('[title="Transmitting"], [title="Hold your push-to-talk key to speak"], [title="Waiting for you to speak"], [title="Mute"], [title="Unmute"]').first();

  try {
    // Still in push-to-talk from the settings step above. Nothing held => gate shut.
    const title = await micButton().getAttribute("title");
    title === "Hold your push-to-talk key to speak"
      ? ok("push-to-talk starts with the gate closed")
      : bad(`expected a closed ptt gate, got title="${title}"`);
  } catch (e) { bad("ptt closed state", String(e)); }

  try {
    await page.keyboard.down("Control");
    await page.waitForTimeout(300);
    const held = await micButton().getAttribute("title");
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    const released = await micButton().getAttribute("title");

    held === "Transmitting"
      ? ok("holding the push-to-talk key opens the gate")
      : bad(`gate did not open while held (title="${held}")`);
    released === "Hold your push-to-talk key to speak"
      ? ok("releasing the key closes the gate again")
      : bad(`gate did not close on release (title="${released}")`);
  } catch (e) { bad("ptt hold/release", String(e)); }

  try {
    // The blur fallback: a key released while the window is unfocused delivers no keyup, which
    // without this would leave the microphone open indefinitely.
    await page.keyboard.down("Control");
    await page.waitForTimeout(200);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForTimeout(200);
    const afterBlur = await micButton().getAttribute("title");
    await page.keyboard.up("Control");
    afterBlur === "Hold your push-to-talk key to speak"
      ? ok("losing window focus while held closes the gate")
      : bad(`gate stayed open across blur (title="${afterBlur}")`);
  } catch (e) { bad("ptt blur fallback", String(e)); }

  try {
    // Regression guard for the bug this refactor fixed: un-deafening used to re-enable the mic
    // outright, so a muted user became live while the UI still said muted.
    await openVoiceSettings();
    await page.getByText("Open mic", { exact: true }).first().click();
    await page.keyboard.press("Escape");

    await page.locator('[title="Mute"]').first().click();          // mute
    await page.locator('[title="Deafen"]').first().click();        // deafen
    await page.locator('[title="Undeafen"]').first().click();      // and back
    await page.waitForTimeout(200);
    const title = await micButton().getAttribute("title");
    title === "Unmute"
      ? ok("un-deafening leaves a muted mic muted")
      : bad(`un-deafen re-opened a muted mic (title="${title}")`);
  } catch (e) { bad("deafen/mute interaction", String(e)); }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
