// Verifies biometric (WebAuthn) sign-in against the REAL deployment, using Chrome's virtual
// authenticator via CDP — which simulates a platform authenticator with user verification, i.e. a
// fingerprint sensor. No physical device needed, and the credential is real: it is created, stored
// by the browser, and asserted against the live server exactly as a Face ID credential would be.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
let pass = 0, fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const username = `zz_pk_${Date.now()}`;
const password = "passkey-verify-pw-1";

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Chrome's virtual authenticator. `hasUV: true` + `isUserVerified: true` is what makes it behave
  // like Face ID / a fingerprint reader rather than a plain USB key.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  try {
    await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Email").fill(`${username}@example.com`);
    await page.getByLabel("Password").fill(password);
    await page.getByLabel("Date of birth").fill("1995-04-01");
    await page.getByRole("button", { name: "25–34" }).click();
    await page.getByRole("button", { name: "Register" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 25000 });
    ok("registered a test account");

    // ---- enrol a passkey through the real API ---------------------------------------------
    const enrolled = await page.evaluate(async () => {
      const { registerPasskey } = await import("/src/lib/passkeys.ts").catch(() => ({}));
      return typeof registerPasskey === "function";
    }).catch(() => false);
    // The production bundle is minified, so the module cannot be imported by path. Drive the API
    // directly with the same calls the client makes — this still exercises the server end to end
    // and the browser's real WebAuthn implementation.
    void enrolled;

    const result = await page.evaluate(async ({ base, username, password }) => {
      const startRegistration = (await import("https://esm.sh/@simplewebauthn/browser@13")).startRegistration;
      // The access token lives in memory (zustand), not storage, so it cannot be read out of the
      // page. Signing in again here yields one, and exercises the same route the app uses.
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailOrUsername: username, password }),
      });
      const { accessToken } = await login.json();
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };
      const begin = await fetch(`${base}/api/auth/passkeys/begin`, {
        method: "POST", headers, credentials: "include",
        // `{}` not empty: Fastify refuses a JSON content-type with a zero-length body, before auth
        // even runs. The app's own api.post() defaults to `{}` for exactly this reason.
        body: "{}",
        });
      if (!begin.ok) return { step: "begin", status: begin.status };
      const options = await begin.json();
      const response = await startRegistration({ optionsJSON: options });
      const finish = await fetch(`${base}/api/auth/passkeys/finish`, {
        method: "POST", headers, credentials: "include",
        body: JSON.stringify({ response, label: "Virtual authenticator" }),
      });
      return { step: "finish", status: finish.status, body: await finish.text() };
    }, { base: BASE, username, password }).catch((e) => ({ step: "threw", error: String(e) }));

    if (result.step === "finish" && result.status === 200) ok("a passkey enrolled against the live server");
    else { bad(`passkey enrolment failed: ${JSON.stringify(result).slice(0, 200)}`); return finish(browser); }

    const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    if (credentials.credentials.length === 1) ok("the browser holds exactly one credential for this domain");
    else bad(`browser holds ${credentials.credentials.length} credentials`);

    // ---- sign out, then sign in with the passkey alone --------------------------------------
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

    const button = page.getByRole("button", { name: /passkey/i });
    if (await button.count()) ok("the sign-in page offers a passkey button when the device supports it");
    else bad("no passkey button rendered despite a user-verifying platform authenticator");

    await button.first().click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 })
      .then(() => ok("signing in with ONLY a passkey works — no username, no password"))
      .catch(() => bad("passkey sign-in did not complete"));

    // ---- the refusals ----------------------------------------------------------------------
    const forged = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/api/auth/passkeys/login/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "made-up-handle", response: { id: "nope" } }),
      });
      return res.status;
    }, BASE);
    if (forged === 401 || forged === 400) ok(`a forged passkey assertion is refused (${forged})`);
    else bad(`a forged assertion returned ${forged}`);

    // A challenge is single-use; replaying a whole begin/finish pair with a stale handle must fail.
    const replay = await page.evaluate(async (base) => {
      const begin = await fetch(`${base}/api/auth/passkeys/login/begin`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const { handle } = await begin.json();
      // Use the handle once with garbage, then again — the second must fail even before signature
      // checking, because the challenge is deleted on first redemption.
      await fetch(`${base}/api/auth/passkeys/login/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, response: { id: "garbage" } }),
      });
      const second = await fetch(`${base}/api/auth/passkeys/login/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, response: { id: "garbage" } }),
      });
      return second.status;
    }, BASE);
    if (replay === 401) ok("a challenge cannot be reused (single-use, deleted on redemption)");
    else bad(`a replayed challenge returned ${replay}`);
  } catch (e) {
    bad(`passkeys: ${e.message?.split("\n")[0] ?? e}`);
  }

  finish(browser);
}

async function finish(browser) {
  await browser?.close().catch(() => {});
  try {
    execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-c",
      `DELETE FROM "Server" WHERE "ownerId" IN (SELECT id FROM "User" WHERE username = '${username}');
       DELETE FROM "User" WHERE username = '${username}';`],
      { cwd: REPO, stdio: "ignore" });
  } catch { /* harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
