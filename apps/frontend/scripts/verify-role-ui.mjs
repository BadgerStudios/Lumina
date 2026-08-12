// Browser verification of platform-role management in the owner console.
//
// The backend for this was proven correct by apps/backend/scripts/verify-master.mjs; what this
// script exists to catch is the failure mode that has bitten this project repeatedly — a bundle
// that typechecks, deploys, and renders a control that does nothing. So every assertion here is
// made against the real rendered DOM after a real click, and persistence is checked by reloading
// rather than by trusting the optimistic update.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-role-ui-pw-1";
let pass = 0,
  fail = 0;

const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m, e) => (console.log(`FAIL: ${m}${e ? " -- " + e : ""}`), fail++);

/** Raw SQL against the live database — the only way to mint the first owner, since the API
 * deliberately refuses to let anyone grant a role they don't already outrank. */
function sql(query) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", query],
    { cwd: "/home/lucid/lumina", encoding: "utf8" },
  ).trim();
}

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
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return username;
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/email or username/i).fill(username);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /^(sign in|log in)$/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

/** The role control for one user row, located by its accessible name so this fails loudly if the
 * control is ever swapped for something a screen reader can't name. */
const roleSelect = (page, username) =>
  page.getByLabel(`Platform role for ${username}`, { exact: true });

async function main() {
  const ownerName = `rui_owner_${rand}`;
  const subjectName = `rui_subject_${rand}`;

  // Everyone who already holds a role, captured before the run. This script drives a real console
  // against the live database, so "did it touch anyone it shouldn't have" is itself an assertion —
  // an earlier version demoted a real staff member through a mis-scoped locator and only the
  // database revealed it.
  const bystandersBefore = sql(
    `select username || '=' || "platformRole" from "User" where "platformRole" <> 'USER' order by username;`,
  );

  await register(ownerName);
  await register(subjectName);
  sql(`update "User" set "platformRole" = 'OWNER' where username = '${ownerName}';`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => bad("uncaught page error", String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
  });

  try {
    await login(page, ownerName);
    ok(`owner logged in (url=${page.url()})`);

    // --- Users directory -------------------------------------------------------------------
    await page.goto(`${BASE}/owner`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^users$/i }).click();
    await page.getByPlaceholder(/search name or email/i).fill(subjectName);
    await roleSelect(page, subjectName).waitFor({ timeout: 15000 });
    ok("Users directory: search found the subject and rendered a role control");

    const options = await roleSelect(page, subjectName)
      .locator("option")
      .allTextContents();
    if (options.join(",") === "User,Staff") {
      ok(`role options are exactly what an owner may assign (${options.join(", ")})`);
    } else {
      bad(`role options should be User,Staff for an owner — got "${options.join(", ")}"`);
    }

    await roleSelect(page, subjectName).selectOption("STAFF");
    await page.waitForResponse(
      (r) => r.url().includes("/role") && r.request().method() === "PATCH",
      { timeout: 15000 },
    );

    const afterGrant = sql(`select "platformRole" from "User" where username = '${subjectName}';`);
    if (afterGrant === "STAFF") ok("dropdown change persisted to the database (STAFF)");
    else bad(`database says ${afterGrant} after granting STAFF`);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^users$/i }).click();
    await page.getByPlaceholder(/search name or email/i).fill(subjectName);
    const shown = await roleSelect(page, subjectName).inputValue();
    if (shown === "STAFF") ok("role survives a full page reload in the UI");
    else bad(`UI shows ${shown} after reload`);

    // The master must not be editable from here — the control should not exist at all rather than
    // exist and fail.
    await page.getByPlaceholder(/search name or email/i).fill("lumina");
    await page.getByText("@lumina", { exact: true }).first().waitFor({ timeout: 15000 });
    if ((await roleSelect(page, "lumina").count()) === 0) {
      ok("master row exposes no role control");
    } else {
      bad("master row rendered an editable role control");
    }
    // The server refuses to ban anyone at owner rank or above; the button must not be offered.
    //
    // Scoped to the master's own row by the button's accessible name. Counting /^ban$/ across the
    // whole page was wrong for the same reason the Remove-access locator was: searching "lumina"
    // matches six accounts (usernames AND emails), five of them ordinary users who correctly DO
    // get a Ban button. The assertion was reading their buttons and calling it a master-row bug.
    if ((await page.getByRole("button", { name: /^Ban lumina$/i }).count()) === 0) {
      ok("master row exposes no Ban button");
    } else {
      bad("master row rendered a Ban button the server would reject");
    }
    // ...and prove the locator can actually see a Ban button when one legitimately exists, so this
    // passing never just means "the selector matched nothing".
    if ((await page.getByRole("button", { name: /^Ban /i }).count()) > 0) {
      ok("ordinary rows in the same result set still offer Ban (the check is not vacuous)");
    } else {
      bad("no Ban button anywhere — the master-row assertion above proves nothing");
    }

    // --- Team & access ---------------------------------------------------------------------
    await page.getByRole("button", { name: /team/i }).click();
    await roleSelect(page, subjectName).waitFor({ timeout: 15000 });
    ok("Team panel lists the newly-promoted staff member with a rank control");

    // Targeted by the button's own per-row accessible name, which now includes the username.
    //
    // The previous attempt at scoping — .locator("div").filter({ hasText: `@${name}` }) — did not
    // scope anything. `filter` keeps every div that CONTAINS the text, which includes the page
    // wrapper, so the search for "Remove access" still ranged over the whole table and `.last()`
    // picked whoever sorted last. This script demoted a real staff account twice that way, the
    // second time after a comment was added claiming it was fixed.
    const removeButton = page.getByRole("button", {
      name: new RegExp(`Remove platform access from ${subjectName}`, "i"),
    });

    // A hard stop, not just a better selector. This script mutates roles on the LIVE database, so
    // the invariant worth enforcing is "it can only ever touch the account it created" — asserted
    // here rather than assumed from a locator being correct.
    const matches = await removeButton.count();
    if (matches !== 1) {
      throw new Error(
        `refusing to click: expected exactly 1 Remove-access button for ${subjectName}, found ${matches}`,
      );
    }
    await removeButton.click();
    await page.waitForResponse(
      (r) => r.url().includes("/master/grant") && r.request().method() === "POST",
      { timeout: 15000 },
    );
    const afterRevoke = sql(`select "platformRole" from "User" where username = '${subjectName}';`);
    if (afterRevoke === "USER") ok("Remove access demoted the subject to USER");
    else bad(`database says ${afterRevoke} after Remove access`);
  } catch (e) {
    bad("role management flow", String(e));
    await page.screenshot({ path: "/tmp/verify-role-ui-failure.png", fullPage: true });
    console.log("screenshot: /tmp/verify-role-ui-failure.png");
  } finally {
    await browser.close();
    sql(`delete from "User" where username in ('${ownerName}', '${subjectName}');`);
    console.log(`cleaned up ${ownerName} and ${subjectName}`);

    const bystandersAfter = sql(
      `select username || '=' || "platformRole" from "User" where "platformRole" <> 'USER' order by username;`,
    );
    if (bystandersAfter === bystandersBefore) {
      ok("no pre-existing role holder was modified");
    } else {
      bad(`this run changed someone else's role\n  before: ${bystandersBefore}\n  after:  ${bystandersAfter}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
