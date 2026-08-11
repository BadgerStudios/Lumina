// Verifies the billing surface exists and tells the truth on an instance with no Stripe keys.
//
// The gap: checkout sessions, the customer portal and signature-verified webhooks were all built
// and working, and nothing in the app referenced any of it — there was no way to subscribe, see
// what you were paying for, or cancel.
//
// The interesting assertions here are about the UNCONFIGURED state, because that is the state this
// instance is genuinely in and the one a billing page most easily lies about: a Subscribe button
// that looks live and fails on click is worse than one that says why it can't work.
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = "https://lumina.luxffa.com";
const API = "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-billing-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

async function main() {
  const user = `vbi_${rand}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // --- the API contract the UI depends on ---------------------------------------------------
    const config = await (await fetch(`${API}/api/billing/config`)).json();
    if (typeof config.configured === "boolean" && Array.isArray(config.plans)) {
      ok(`/billing/config describes ${config.plans.length} plan(s), configured=${config.configured}`);
    } else {
      return bad(`/billing/config returned an unexpected shape: ${JSON.stringify(config).slice(0, 120)}`);
    }

    // The publishable key is safe to expose by design; the SECRET key must never appear in any
    // response. Checked because a config endpoint is exactly where that mistake gets made.
    const raw = JSON.stringify(config);
    if (!raw.includes("sk_live") && !raw.includes("sk_test")) ok("no secret key is exposed by the config endpoint");
    else bad("the billing config response contains a Stripe SECRET key");

    // --- the UI --------------------------------------------------------------------------------
    await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Email").fill(`${user}@example.com`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Date of birth").fill("1995-04-01");
    await page.getByRole("button", { name: "25–34" }).click();
    await page.getByRole("button", { name: "Register" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 20000 });

    await page.getByRole("button", { name: "User Settings" }).click();
    const billingTab = page.getByRole("button", { name: "Billing", exact: true });
    if (await billingTab.isVisible().catch(() => false)) ok("user settings has a Billing section");
    else return bad("there is no Billing section in user settings");

    await billingTab.click();

    // The section fetches its config on mount, so everything below has to wait for that rather
    // than sampling the pane the instant the tab is clicked — an empty pane mid-fetch is not the
    // same as a missing feature, and asserting immediately can't tell them apart.
    const planName = config.plans[0]?.name;
    const planText = page.getByText(planName).first();
    try {
      await planText.waitFor({ state: "visible", timeout: 15000 });
      ok(`the plan "${planName}" is shown to the user`);
    } catch {
      bad(`the plan "${planName}" is not rendered`);
    }

    const subscribe = page.getByRole("button", { name: "Subscribe" }).first();
    try {
      await subscribe.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      return bad("no Subscribe button rendered");
    }

    if (config.configured) {
      // Keys are present: the button must be live. Deliberately NOT clicked — that would start a
      // real Stripe Checkout session against a live account.
      if (await subscribe.isEnabled()) ok("with Stripe configured, Subscribe is live");
      else bad("Stripe is configured but Subscribe is disabled");
    } else {
      // The state this instance is actually in.
      if (await subscribe.isDisabled()) ok("with no Stripe keys, Subscribe is disabled rather than failing on click");
      else bad("Subscribe looks live on an instance that cannot take payments");

      const notice = page.getByText(/Payments aren't switched on/i);
      if (await notice.isVisible().catch(() => false)) ok("the page says plainly that payments aren't switched on");
      else bad("nothing explains why subscribing is unavailable");
    }

    // A user with no subscription must not be shown a management surface for one.
    if (!(await page.getByRole("button", { name: "Manage billing" }).isVisible().catch(() => false))) {
      ok("no billing-management controls are shown to someone with no subscription");
    } else {
      bad("a user with no subscription is offered 'Manage billing'");
    }
  } catch (e) {
    bad(`billing ui: ${String(e).split("\n")[0]}`);
  } finally {
    await browser.close();
    sql(`delete from "User" where username = '${user}';`);
    console.log(`cleaned up ${user}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
