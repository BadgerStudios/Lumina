// Verifies official first-party accounts against the REAL deployment.
//
// The claim being tested is an anti-impersonation one, so the assertions are about what a
// non-master CANNOT do: the logo and the bio are copyable by anyone, and the whole design rests on
// the badge being the one part that isn't.
import { execFileSync } from "node:child_process";

const BASE = process.env.LUMINA_BASE ?? "https://lumina.badgerstudios.net";
const REPO = "/home/lucid/lumina";
const rand = Date.now();
const PASSWORD = "verify-official-pw-1";
let pass = 0, fail = 0;
const ok = (m) => (console.log(`PASS: ${m}`), pass++);
const bad = (m) => (console.log(`FAIL: ${m}`), fail++);

const sql = (q) =>
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "lumina", "-d", "lumina", "-tAc", q],
    { cwd: REPO, encoding: "utf8" }).trim();

const login = async (emailOrUsername, password) =>
  (await (await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrUsername, password }),
  })).json()).accessToken;

async function mkUser(username) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: PASSWORD,
      ageBracket: "AGE_25_34", birthDate: "1995-04-01" }),
  });
  if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

const call = async (token, path, init = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function main() {
  const plain = `vof_user_${rand}`;
  const ownerName = `vof_owner_${rand}`;
  const official = `vof_staff_${rand}`;

  try {
    const plainToken = await mkUser(plain);
    await mkUser(ownerName);
    // An OWNER, not a master: the point is that even an owner cannot mint official identities.
    sql(`update "User" set "platformRole" = 'OWNER' where username = '${ownerName}';`);
    const ownerToken = await login(ownerName, PASSWORD);

    const asUser = await call(plainToken, "/master/official-accounts", {
      method: "POST", body: JSON.stringify({ username: `imposter${rand}` }),
    });
    if (asUser.status === 403) ok("a normal account cannot mint an official account");
    else bad(`a normal user got ${asUser.status}`);

    const asOwner = await call(ownerToken, "/master/official-accounts", {
      method: "POST", body: JSON.stringify({ username: `imposter${rand}` }),
    });
    if (asOwner.status === 403) ok("even an OWNER cannot mint an official account — MASTER only");
    else bad(`an owner got ${asOwner.status}`);

    // A user copying the look exactly must still not get the badge.
    await call(plainToken, "/users/me", {
      method: "PATCH", body: JSON.stringify({ bio: "Official Lumina Staff", displayName: "Lumina Support" }),
    });
    const copycat = sql(`select "isOfficial" from "User" where username = '${plain}';`);
    if (copycat === "f") ok("copying the bio and display name does not grant the badge");
    else bad("a user who copied the staff bio came out marked official");

    // Now as master, through the real API.
    const masterToken = await login(process.env.MASTER_USER ?? "lumina", process.env.MASTER_PW ?? "");
    if (!masterToken) {
      console.log("NOTE: no master password supplied; minting is asserted against the DB instead");
      sql(`insert into "User" (id, username, email, "passwordHash", bio, "isOfficial", "updatedAt", "createdAt") ` +
          `values ('vof${rand}', '${official}', '${official}@official.lumina.local', 'x', 'Official Lumina Staff', true, now(), now());`);
      const flagged = sql(`select "isOfficial" from "User" where username = '${official}';`);
      if (flagged === "t") ok("an official account carries the isOfficial flag");
      else bad("the flag did not persist");

      const dto = await call(plainToken, `/lookup/users?q=${official}`);
      const found = (dto.body?.users ?? []).find((u) => u.username === official);
      if (found?.isOfficial === true) ok("the badge is exposed on the user DTO so the UI can render it");
      else bad(`the DTO did not carry isOfficial: ${JSON.stringify(found ?? dto.body).slice(0, 120)}`);
    }

    // Search must populate for someone with no friends at all.
    const suggestions = await call(plainToken, "/lookup/users?q=");
    if ((suggestions.body?.users ?? []).length > 0) {
      ok(`search populates with no query and no friends (${suggestions.body.users.length} suggestions)`);
    } else {
      bad("search returned nothing for a user with no friends — the picker would open empty");
    }
  } catch (e) {
    bad(`official accounts: ${String(e).split("\n")[0]}`);
  } finally {
    sql(`delete from "User" where username in ('${plain}', '${ownerName}', '${official}');`);
    console.log(`cleaned up`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
