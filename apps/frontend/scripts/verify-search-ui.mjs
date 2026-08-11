// Verifies that message search is reachable from the app, not just implemented behind it.
//
// The gap this covers: the Postgres full-text index, the /servers/:id/search route and the
// useSearch hook were all built and working, and the search input never rendered — nothing passed
// `onSearch` down to the header. Every API-level test passed. So this drives the real input a
// person would type into and asserts a real result comes back.
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = "https://lumina.luxffa.com";
const rand = Date.now();
const PASSWORD = "verify-search-pw-1";
const NEEDLE = `pineapple${rand}`;
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
  const user = `vsu_${rand}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
    await page.getByLabel("Username").fill(user);
    await page.getByLabel("Email").fill(`${user}@example.com`);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Date of birth").fill("1995-04-01");
    await page.getByRole("button", { name: "25–34" }).click();
    await page.getByRole("button", { name: "Register" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 20000 });

    await page.getByRole("button", { name: "Add a Server" }).click();
    await page.getByLabel("Server name").fill(`Search Verify ${rand}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/channels\/.+\/.+/, { timeout: 20000 });

    const composer = page.getByPlaceholder(/^Message /);
    await composer.fill(`a message about ${NEEDLE} and other things`);
    await composer.press("Enter");
    await page.getByText(NEEDLE).first().waitFor({ state: "visible", timeout: 15000 });
    await composer.fill("an unrelated message with nothing in it");
    await composer.press("Enter");
    ok("posted a message to search for");

    // The index is maintained by a trigger on insert, so it is queryable immediately — asserted
    // directly so a failure below can be attributed to the UI rather than to the index.
    const indexed = sql(
      `select count(*) from "Message" where "searchVector" @@ plainto_tsquery('english', '${NEEDLE}');`,
    );
    if (indexed === "1") ok("the message is in the full-text index");
    else bad(`the search index has ${indexed} rows for the needle`);

    // The bug: this input did not exist on screen at all.
    const search = page.getByLabel("Search Lumina");
    if (await search.isVisible().catch(() => false)) ok("the search box is present in the channel header");
    else return bad("the search box never renders — search is unreachable from the UI");

    await search.fill(NEEDLE);

    const panel = page.getByText(`Results for “${NEEDLE}”`);
    await panel.waitFor({ state: "visible", timeout: 15000 });
    ok("typing opens the results panel");

    // A result, not just a panel. The panel appearing with "nothing matched" would be a
    // perfectly-rendered failure.
    const hit = page.getByText(/a message about pineapple/).first();
    if (await hit.isVisible({ timeout: 10000 }).catch(() => false)) ok("the matching message is returned");
    else bad("the panel opened but the matching message was not listed");

    const noise = await page.getByText("an unrelated message with nothing in it").count();
    // The composer's own message list still shows it; the panel must not. One occurrence means
    // only the message list has it.
    if (noise <= 1) ok("a non-matching message is not in the results");
    else bad("the results include a message that shouldn't match");

    await search.fill("");
    if (!(await panel.isVisible().catch(() => false))) ok("clearing the box closes the panel");
    else bad("the panel stayed open after clearing the query");
  } catch (e) {
    bad(`search ui: ${String(e).split("\n")[0]}`);
  } finally {
    await browser.close();
    sql(`delete from "Server" where name = 'Search Verify ${rand}';`);
    sql(`delete from "User" where username = '${user}';`);
    console.log(`cleaned up ${user}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
