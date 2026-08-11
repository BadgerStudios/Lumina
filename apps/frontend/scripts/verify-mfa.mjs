// End-to-end verification of two-factor auth against the REAL deployment.
//
// The assertions that matter here are the refusals. A second factor that accepts everything passes
// every "the right code works" test and protects nothing — so this checks a wrong code, a replayed
// backup code, a spent ticket, and a forged ticket, alongside the happy path.
import { execFileSync } from "node:child_process";
import { generateSync } from "otplib";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
let pass = 0, fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

async function call(path, { method = "POST", token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Client-Type": "mobile",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const username = `mfa_${Date.now()}`;
const password = "mfa-verify-pw-1";

async function main() {
  const reg = await call("/auth/register", {
    body: { username, email: `${username}@example.com`, password, ageBracket: "AGE_25_34", birthDate: "1995-04-01" },
  });
  if (reg.status !== 201) { bad(`register failed (${reg.status})`); return finish(); }
  const token = reg.body.accessToken;

  // ---- enrolment ---------------------------------------------------------------------------
  const begin = await call("/auth/mfa/begin", { token });
  if (begin.status === 200 && begin.body.secret && begin.body.otpauthURI?.startsWith("otpauth://totp/")) {
    ok("enrolment returns a secret and a scannable otpauth URI");
  } else {
    bad(`mfa/begin returned ${begin.status}`); return finish();
  }
  const secret = begin.body.secret;

  // Enrolment must NOT take effect until proven — otherwise a failed scan locks the account out.
  const beforeConfirm = await call("/auth/login", { body: { emailOrUsername: username, password } });
  if (!beforeConfirm.body?.mfaRequired) ok("2FA is not enforced until a code is confirmed");
  else bad("2FA became enforced before the user proved they could produce a code");

  const wrong = await call("/auth/mfa/confirm", { token, body: { code: "000000" } });
  if (wrong.status >= 400) ok(`a wrong confirmation code is refused (${wrong.status})`);
  else bad("a wrong confirmation code was accepted — the enrolment check is not checking");

  const confirm = await call("/auth/mfa/confirm", {
    token,
    body: { code: generateSync({ secret, strategy: "totp" }) },
  });
  if (confirm.status === 200 && Array.isArray(confirm.body.backupCodes) && confirm.body.backupCodes.length === 10) {
    ok("a valid code enables 2FA and returns 10 backup codes");
  } else {
    bad(`mfa/confirm returned ${confirm.status}`); return finish();
  }
  const backupCodes = confirm.body.backupCodes;

  // ---- login now requires the second factor -------------------------------------------------
  const login = await call("/auth/login", { body: { emailOrUsername: username, password } });
  if (login.body?.mfaRequired && login.body.mfaTicket) ok("login now returns a challenge instead of a session");
  else { bad("login did not require the second factor"); return finish(); }

  // The critical one: the password step must not hand out a usable session.
  if (!login.body.accessToken) ok("no access token is issued at the password step");
  else bad("login returned an access token BEFORE the second factor — the whole feature is theatre");

  const forged = await call("/auth/login/verify-mfa", { body: { mfaTicket: "forged-ticket", code: "123456" } });
  if (forged.status === 401) ok("a forged ticket is refused (401)");
  else bad(`a forged ticket returned ${forged.status}`);

  const wrongCode = await call("/auth/login/verify-mfa", {
    body: { mfaTicket: login.body.mfaTicket, code: "000000" },
  });
  if (wrongCode.status === 401) ok("a wrong code is refused (401)");
  else bad(`a wrong code returned ${wrongCode.status}`);

  // A ticket is one attempt. Reusing it after a failure would make the attempt limit meaningless.
  const replayTicket = await call("/auth/login/verify-mfa", {
    body: { mfaTicket: login.body.mfaTicket, code: generateSync({ secret, strategy: "totp" }) },
  });
  if (replayTicket.status === 401) ok("a spent ticket cannot be reused, even with a correct code");
  else bad("a spent ticket was accepted again — brute force against one ticket is possible");

  const login2 = await call("/auth/login", { body: { emailOrUsername: username, password } });
  const good = await call("/auth/login/verify-mfa", {
    body: { mfaTicket: login2.body.mfaTicket, code: generateSync({ secret, strategy: "totp" }) },
  });
  if (good.status === 200 && good.body.accessToken) ok("a correct TOTP code completes the login");
  else bad(`verify-mfa with a correct code returned ${good.status}`);

  // ---- backup codes -------------------------------------------------------------------------
  const login3 = await call("/auth/login", { body: { emailOrUsername: username, password } });
  const viaBackup = await call("/auth/login/verify-mfa", {
    body: { mfaTicket: login3.body.mfaTicket, code: backupCodes[0] },
  });
  if (viaBackup.status === 200 && viaBackup.body.accessToken) ok("a backup code completes the login");
  else bad(`a backup code returned ${viaBackup.status}`);

  const login4 = await call("/auth/login", { body: { emailOrUsername: username, password } });
  const reuse = await call("/auth/login/verify-mfa", {
    body: { mfaTicket: login4.body.mfaTicket, code: backupCodes[0] },
  });
  if (reuse.status === 401) ok("the same backup code cannot be used twice");
  else bad("a backup code was accepted twice — they are not single-use");

  const status = await call("/auth/mfa", { method: "GET", token: viaBackup.body.accessToken });
  if (status.body?.enabled && status.body.backupCodesRemaining === 9) {
    ok(`status reports 2FA on with ${status.body.backupCodesRemaining} codes left`);
  } else {
    bad(`status reported ${JSON.stringify(status.body)}`);
  }

  // ---- disabling requires the password ------------------------------------------------------
  const badDisable = await call("/auth/mfa/disable", {
    token: viaBackup.body.accessToken,
    body: { password: "not-the-password" },
  });
  if (badDisable.status === 401) ok("turning 2FA off with the wrong password is refused");
  else bad("2FA was disabled without the correct password — a stolen session could strip it");

  const disable = await call("/auth/mfa/disable", { token: viaBackup.body.accessToken, body: { password } });
  if (disable.status === 204) ok("the correct password turns it off");
  else bad(`disable returned ${disable.status}`);

  const after = await call("/auth/login", { body: { emailOrUsername: username, password } });
  if (after.body?.accessToken && !after.body?.mfaRequired) ok("login returns to one step once disabled");
  else bad("login still demands a second factor after disabling");

  finish();
}

function finish() {
  try {
    execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-c",
      `DELETE FROM "Server" WHERE "ownerId" IN (SELECT id FROM "User" WHERE username = '${username}');
       DELETE FROM "User" WHERE username = '${username}';`],
      { cwd: REPO, stdio: "ignore" });
  } catch { /* leftover test account is harmless */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
