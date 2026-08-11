// Verifies that server moderation is actually reachable from the UI.
//
// The bug this exists for: the kick, ban and nickname ROUTES were fully built and enforced, the
// query hooks existed, and nothing in the app ever called them. Everything an API-level test could
// check already passed — so the only test that would have caught it is one that drives the real
// menu a moderator would use. That is what this does, and it asserts the outcome against the
// database rather than against what the screen appears to say.
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = "https://lumina.luxffa.com";
const API = "https://lumina.badgerstudios.net";
const rand = Date.now();
const PASSWORD = "verify-member-pw-1";
let pass = 0,
  fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q], {
    cwd: "/home/lucid/lumina",
    encoding: "utf8",
  }).trim();

async function register(page, username) {
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(`${username}@example.com`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Date of birth").fill("1995-04-01");
  await page.getByRole("button", { name: "25–34" }).click();
  await page.getByRole("button", { name: "Register" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 20000 });
}

async function main() {
  const owner = `vma_owner_${rand}`;
  const target = `vma_target_${rand}`;
  const browser = await chromium.launch();
  const ownerCtx = await browser.newContext();
  const targetCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  const targetPage = await targetCtx.newPage();

  try {
    await register(ownerPage, owner);
    await register(targetPage, target);

    await ownerPage.getByRole("button", { name: "Add a Server" }).click();
    await ownerPage.getByLabel("Server name").fill(`Member Actions ${rand}`);
    await ownerPage.getByRole("button", { name: "Create", exact: true }).click();
    await ownerPage.waitForURL(/\/channels\/.+\/.+/, { timeout: 20000 });

    await ownerPage.getByRole("button", { name: "Invite People" }).click();
    await ownerPage.getByRole("button", { name: "Generate new invite link" }).click();
    const urlText = await ownerPage.getByText(/\/invite\//).first().innerText({ timeout: 15000 });
    const code = urlText.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
    if (!code) throw new Error(`could not parse an invite code out of "${urlText}"`);
    await ownerPage.keyboard.press("Escape");

    await targetPage.goto(`${BASE}/invite/${code}`, { waitUntil: "networkidle" });
    await targetPage.getByRole("button", { name: "Accept Invite" }).click();
    await targetPage.waitForURL(/\/channels\/.+/, { timeout: 20000 });
    ok("a second member joined the server");

    const serverId = sql(`select id from "Server" where name = 'Member Actions ${rand}';`);
    const targetId = sql(`select id from "User" where username = '${target}';`);

    // Open the member's row menu. The trigger is the per-row manage button, not the avatar (which
    // opens the profile card).
    await ownerPage.reload({ waitUntil: "networkidle" });
    const row = ownerPage.locator("div.group", { hasText: target }).first();
    await row.hover();
    await row.getByRole("button").last().click();

    for (const label of ["Set nickname", "Kick from server", "Ban from server"]) {
      if (await ownerPage.getByText(label, { exact: true }).isVisible().catch(() => false)) {
        ok(`the member menu offers "${label}"`);
      } else {
        bad(`"${label}" is missing from the member menu`);
      }
    }

    // --- nickname ---------------------------------------------------------------------------
    ownerPage.once("dialog", (d) => d.accept("Renamed By Test"));
    await ownerPage.getByText("Set nickname", { exact: true }).click();
    const renamed = await waitFor(
      () => sql(`select coalesce(nickname,'') from "Membership" where "userId" = '${targetId}' and "serverId" = '${serverId}';`) === "Renamed By Test",
    );
    if (renamed) ok("setting a nickname writes it to the membership");
    else bad("the nickname never reached the database");

    // --- kick -------------------------------------------------------------------------------
    await ownerPage.reload({ waitUntil: "networkidle" });
    const row2 = ownerPage.locator("div.group", { hasText: "Renamed By Test" }).first();
    await row2.hover();
    await row2.getByRole("button").last().click();
    ownerPage.once("dialog", (d) => d.accept());
    await ownerPage.getByText("Kick from server", { exact: true }).click();

    const kicked = await waitFor(
      () => sql(`select count(*) from "Membership" where "userId" = '${targetId}' and "serverId" = '${serverId}';`) === "0",
    );
    if (kicked) ok("kicking from the menu actually removes the membership");
    else bad("the member is still in the server after a kick");

    // --- ban --------------------------------------------------------------------------------
    // Rejoin so there is someone to ban. This also confirms a kick is not a ban: they can come back.
    await targetPage.goto(`${BASE}/invite/${code}`, { waitUntil: "networkidle" });
    await targetPage.getByRole("button", { name: "Accept Invite" }).click();
    await targetPage.waitForURL(/\/channels\/.+/, { timeout: 20000 });
    if (sql(`select count(*) from "Membership" where "userId" = '${targetId}' and "serverId" = '${serverId}';`) === "1") {
      ok("a kicked member can rejoin — a kick is not a ban");
    } else {
      bad("the kicked member could not rejoin");
    }

    await ownerPage.reload({ waitUntil: "networkidle" });
    const row3 = ownerPage.locator("div.group", { hasText: target }).first();
    await row3.hover();
    await row3.getByRole("button").last().click();
    // Two dialogs: the confirm, then the reason prompt.
    ownerPage.on("dialog", (d) => d.accept("verify ban"));
    await ownerPage.getByText("Ban from server", { exact: true }).click();

    const banned = await waitFor(() => sql(`select count(*) from "Ban" where "userId" = '${targetId}' and "serverId" = '${serverId}';`) === "1");
    if (banned) ok("banning from the menu creates a real ban row");
    else bad("no ban row was created");

    // The point of the whole fix: the Bans tab could previously only list bans that were
    // impossible to create through the UI.
    const stillMember = sql(`select count(*) from "Membership" where "userId" = '${targetId}' and "serverId" = '${serverId}';`);
    if (stillMember === "0") ok("a banned member is removed from the server");
    else bad("the banned member is still a member");
  } catch (e) {
    bad(`member actions: ${String(e).split("\n")[0]}`);
  } finally {
    await browser.close();
    sql(`delete from "Server" where name = 'Member Actions ${rand}';`);
    sql(`delete from "User" where username in ('${owner}', '${target}');`);
    console.log(`cleaned up ${owner}, ${target}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (check()) return true;
    } catch {
      /* row not there yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

void API;
main();
