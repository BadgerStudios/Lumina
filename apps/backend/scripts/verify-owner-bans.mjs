/**
 * Owner suite + platform bans: role ladder, dashboard data, ban fan-out, evasion blocking,
 * appeal flow. Runs against the real deployment. Requires OWNER_TOKEN.
 */
const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const OWNER_TOKEN = process.env.OWNER_TOKEN;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function rnd() {
  return `${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

async function register(tag, fingerprint) {
  const stamp = rnd();
  const body = {
    username: `ob_${tag}_${stamp}`,
    email: `ob_${tag}_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34", birthDate: "1995-06-15",
  };
  const headers = { "content-type": "application/json" };
  if (fingerprint) headers["x-device-fingerprint"] = fingerprint;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, creds: body };
}

async function login(emailOrUsername, password, fingerprint) {
  const headers = { "content-type": "application/json" };
  if (fingerprint) headers["x-device-fingerprint"] = fingerprint;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emailOrUsername, password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function ownerGet(path) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { authorization: `Bearer ${OWNER_TOKEN}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function ownerPost(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  if (!OWNER_TOKEN) throw new Error("OWNER_TOKEN required");

  // --- role ladder ---
  const stats = await ownerGet("/owner/stats");
  check("owner can read platform stats", stats.status === 200, `got ${stats.status}`);
  check("stats report real user counts", typeof stats.body?.users?.total === "number",
    `total=${stats.body?.users?.total}`);

  const plain = await register("plain");
  check("ordinary user registers with role USER", plain.body?.user?.platformRole === "USER",
    `role=${plain.body?.user?.platformRole}`);

  const plainOwner = await fetch(`${BASE}/api/owner/stats`, {
    headers: { authorization: `Bearer ${plain.body.accessToken}` },
  });
  check("non-owner blocked from /api/owner (403)", plainOwner.status === 403, `got ${plainOwner.status}`);

  const plainStaff = await fetch(`${BASE}/api/staff/videos`, {
    headers: { authorization: `Bearer ${plain.body.accessToken}` },
  });
  check("non-staff blocked from /api/staff (403)", plainStaff.status === 403, `got ${plainStaff.status}`);

  const health = await ownerGet("/owner/health");
  check("health reports database reachable", health.body?.database?.ok === true);
  check("health reports the real transcode queue", health.body?.transcodeQueue?.available === true,
    JSON.stringify(health.body?.transcodeQueue));

  const attention = await ownerGet("/owner/attention");
  check("attention endpoint responds with a list", Array.isArray(attention.body?.items));

  // --- promote to staff, verify ladder ---
  const roleRes = await fetch(`${BASE}/api/owner/users/${plain.body.user.id}/role`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ platformRole: "STAFF" }),
  });
  check("owner can promote a user to staff", roleRes.status === 200, `got ${roleRes.status}`);

  const nowStaff = await fetch(`${BASE}/api/staff/videos`, {
    headers: { authorization: `Bearer ${plain.body.accessToken}` },
  });
  check("promoted user immediately reaches staff routes (no re-login)", nowStaff.status === 200,
    `got ${nowStaff.status}`);

  const stillNotOwner = await fetch(`${BASE}/api/owner/stats`, {
    headers: { authorization: `Bearer ${plain.body.accessToken}` },
  });
  check("staff still cannot reach owner routes", stillNotOwner.status === 403, `got ${stillNotOwner.status}`);

  // demote back so the ban test isn't operating on a staff account
  await fetch(`${BASE}/api/owner/users/${plain.body.user.id}/role`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ platformRole: "USER" }),
  });

  // --- ban a user, with device + email fan-out ---
  const fingerprint = `fp_${rnd()}`;
  const victim = await register("victim", fingerprint);
  check("victim registered", victim.status === 201, `got ${victim.status}`);

  // establish a session so the device fingerprint is recorded against the account
  await login(victim.creds.username, victim.creds.password, fingerprint);

  const ban = await ownerPost(`/owner/users/${victim.body.user.id}/ban`, {
    reason: "verification ban",
    durationDays: null,
    banEmail: true,
    banIp: false,
    banDevice: true,
  });
  check("owner can ban a user", ban.status === 200, `got ${ban.status}`);
  check("ban fanned out to multiple identifiers", (ban.body?.identifiersBanned ?? 0) >= 2,
    `${ban.body?.identifiersBanned} identifiers`);

  // --- banned user cannot log back in ---
  const bannedLogin = await login(victim.creds.username, victim.creds.password, fingerprint);
  check("banned user cannot log in (403)", bannedLogin.status === 403, `got ${bannedLogin.status}`);
  check("ban response carries the reason", bannedLogin.body?.details?.reason === "verification ban",
    `reason=${bannedLogin.body?.details?.reason}`);
  check("ban response carries a code the client can switch on",
    bannedLogin.body?.code === "PLATFORM_BANNED", `code=${bannedLogin.body?.code}`);
  const banId = bannedLogin.body?.details?.banId;
  check("ban response carries an appeal id", Boolean(banId));

  // --- existing session is killed ---
  const oldToken = victim.body.accessToken;
  const withOldToken = await fetch(`${BASE}/api/auth/me`, {
    headers: { authorization: `Bearer ${oldToken}` },
  });
  check("banned user's existing access token is rejected", withOldToken.status === 403,
    `got ${withOldToken.status}`);

  // --- evasion: same device, brand new email ---
  const evader = await register("evader", fingerprint);
  check("new signup from the banned device is blocked (403)", evader.status === 403,
    `got ${evader.status}`);
  check("device-scoped block is reported as such", evader.body?.details?.scope === "DEVICE",
    `scope=${evader.body?.details?.scope}`);

  // --- a different device is NOT blocked (no over-blocking) ---
  const unrelated = await register("unrelated", `fp_${rnd()}`);
  check("unrelated device can still register", unrelated.status === 201, `got ${unrelated.status}`);

  // --- appeal flow (unauthenticated, as a banned user must be) ---
  const appeal = await fetch(`${BASE}/api/bans/${banId}/appeal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "This is a verification appeal, please review." }),
  });
  check("banned user can submit an appeal without authenticating", appeal.status === 201,
    `got ${appeal.status}`);

  const shortAppeal = await fetch(`${BASE}/api/bans/${banId}/appeal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "no" }),
  });
  check("too-short appeal rejected (400)", shortAppeal.status === 400, `got ${shortAppeal.status}`);

  const appealsList = await ownerGet("/owner/bans?appeals=true");
  const pending = Array.isArray(appealsList.body)
    ? appealsList.body.find((b) => b.groupId === ban.body.groupId)
    : null;
  check("appeal appears in the owner's pending queue", Boolean(pending),
    `${Array.isArray(appealsList.body) ? appealsList.body.length : 0} pending`);
  check("appeal text is visible to the owner",
    pending?.appealText === "This is a verification appeal, please review.");

  // --- approving an appeal must actually unban ---
  const resolve = await ownerPost(`/owner/bans/${ban.body.groupId}/appeal`, {
    approve: true,
    response: "Verification — approved.",
  });
  check("owner can approve an appeal", resolve.status === 200, `got ${resolve.status}`);

  const afterAppeal = await login(victim.creds.username, victim.creds.password, fingerprint);
  check("approved appeal restores access", afterAppeal.status === 200, `got ${afterAppeal.status}`);

  const evaderAfter = await register("evader2", fingerprint);
  check("lifting the ban also clears the device block", evaderAfter.status === 201,
    `got ${evaderAfter.status}`);

  // --- owners cannot be banned, and self-ban is refused ---
  const me = await ownerGet("/auth/me");
  const selfBan = await ownerPost(`/owner/users/${me.body?.id}/ban`, {
    reason: "should fail",
    durationDays: null,
    banEmail: false,
    banIp: false,
    banDevice: false,
  });
  check("owner cannot ban themselves (400)", selfBan.status === 400, `got ${selfBan.status}`);

  const selfDemote = await fetch(`${BASE}/api/owner/users/${me.body?.id}/role`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ platformRole: "USER" }),
  });
  check("owner cannot demote themselves (400)", selfDemote.status === 400, `got ${selfDemote.status}`);

  // --- user directory ---
  const users = await ownerGet(`/owner/users?q=${encodeURIComponent(victim.creds.username)}`);
  check("owner can search the user directory",
    users.status === 200 && users.body?.users?.some((u) => u.username === victim.creds.username),
    `found ${users.body?.users?.length ?? 0}`);
  check("directory exposes email to the owner", Boolean(users.body?.users?.[0]?.email));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exitCode = 1;
});
