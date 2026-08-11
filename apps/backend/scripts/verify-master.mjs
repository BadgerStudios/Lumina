/**
 * MASTER tier, role granting, typeahead lookup, and brand-kit upload.
 * Requires MASTER_TOKEN (an account whose email is in MASTER_EMAIL).
 */
const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const MASTER_TOKEN = process.env.MASTER_TOKEN;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function req(path, opts = {}, token = MASTER_TOKEN) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function register(prefix) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const body = {
    username: `${prefix}_${stamp}`,
    email: `${prefix}_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34", birthDate: "1995-06-15",
    displayName: `${prefix} Display ${stamp.slice(-4)}`,
  };
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { token: json.accessToken, user: json.user, creds: body };
}

async function main() {
  if (!MASTER_TOKEN) throw new Error("MASTER_TOKEN required");

  const me = await req("/auth/me");
  check("master account resolves as MASTER", me.body?.platformRole === "MASTER",
    `role=${me.body?.platformRole}`);

  // --- master-only surfaces ---
  const config = await req("/master/config");
  check("master can read platform configuration", config.status === 200, `got ${config.status}`);
  check("configuration reports presence, never secret values",
    typeof config.body?.billing?.stripeSecretKey === "boolean" &&
      !JSON.stringify(config.body).includes("sk_"),
    "no key material in response");

  const plain = await register("pl");
  const plainConfig = await req("/master/config", {}, plain.token);
  check("ordinary user blocked from master config (403)", plainConfig.status === 403,
    `got ${plainConfig.status}`);

  // --- team + granting ---
  const team = await req("/master/team");
  check("master can list the team", team.status === 200, `got ${team.status}`);
  check("master may assign OWNER and STAFF",
    team.body?.assignableRoles?.includes("OWNER") && team.body?.assignableRoles?.includes("STAFF"),
    JSON.stringify(team.body?.assignableRoles));
  check("MASTER is never offered as an assignable role",
    !team.body?.assignableRoles?.includes("MASTER"));

  const target = await register("tg");
  const grantStaff = await req("/master/grant", {
    method: "POST",
    body: JSON.stringify({ userId: target.user.id, platformRole: "STAFF" }),
  });
  check("master can grant STAFF", grantStaff.status === 200, `got ${grantStaff.status}`);

  const staffAccess = await req("/staff/videos", {}, target.token);
  check("newly granted staff reach the review queue immediately", staffAccess.status === 200,
    `got ${staffAccess.status}`);

  const staffBlockedFromOwner = await req("/owner/stats", {}, target.token);
  check("staff still blocked from owner routes", staffBlockedFromOwner.status === 403,
    `got ${staffBlockedFromOwner.status}`);

  // staff cannot grant anything
  const staffGrant = await req(
    "/master/grant",
    { method: "POST", body: JSON.stringify({ userId: plain.user.id, platformRole: "STAFF" }) },
    target.token,
  );
  check("staff cannot grant roles (403)", staffGrant.status === 403, `got ${staffGrant.status}`);

  // promote to owner, then confirm an owner cannot mint another owner
  await req("/master/grant", {
    method: "POST",
    body: JSON.stringify({ userId: target.user.id, platformRole: "OWNER" }),
  });
  const ownerTeam = await req("/master/team", {}, target.token);
  check("owner may assign STAFF only",
    ownerTeam.body?.assignableRoles?.includes("STAFF") &&
      !ownerTeam.body?.assignableRoles?.includes("OWNER"),
    JSON.stringify(ownerTeam.body?.assignableRoles));

  const ownerMakesOwner = await req(
    "/master/grant",
    { method: "POST", body: JSON.stringify({ userId: plain.user.id, platformRole: "OWNER" }) },
    target.token,
  );
  check("owner cannot appoint another owner (400)", ownerMakesOwner.status === 400,
    `got ${ownerMakesOwner.status}`);

  const ownerReadsConfig = await req("/master/config", {}, target.token);
  check("owner cannot read master configuration (403)", ownerReadsConfig.status === 403,
    `got ${ownerReadsConfig.status}`);

  // nobody can demote the master
  const demoteMaster = await req("/master/grant", {
    method: "POST",
    body: JSON.stringify({ userId: me.body.id, platformRole: "USER" }),
  });
  check("master cannot be demoted through the API (400)", demoteMaster.status === 400,
    `got ${demoteMaster.status}`);

  // cleanup: drop the test account back to USER
  await req("/master/grant", {
    method: "POST",
    body: JSON.stringify({ userId: target.user.id, platformRole: "USER" }),
  });

  // --- typeahead lookup ---
  const short = await req(`/lookup/users?q=a`, {}, plain.token);
  check("lookup ignores queries under 2 characters", short.body?.users?.length === 0);

  const byUsername = await req(
    `/lookup/users?q=${encodeURIComponent(target.creds.username.slice(0, 8))}`,
    {},
    plain.token,
  );
  check("lookup finds a user by username prefix",
    byUsername.body?.users?.some((u) => u.id === target.user.id),
    `${byUsername.body?.users?.length ?? 0} results`);

  const found = byUsername.body?.users?.find((u) => u.id === target.user.id);
  check("lookup result carries avatar, username and display name",
    found !== undefined &&
      "avatarUrl" in found &&
      typeof found.username === "string" &&
      "displayName" in found,
    JSON.stringify(Object.keys(found ?? {})).slice(0, 90));

  const byDisplay = await req(
    `/lookup/users?q=${encodeURIComponent("Display")}`,
    {},
    plain.token,
  );
  check("lookup matches display name too", (byDisplay.body?.users?.length ?? 0) > 0,
    `${byDisplay.body?.users?.length ?? 0} results`);

  // Email must never be searchable — that would let anyone confirm an address has an account.
  const byEmail = await req(
    `/lookup/users?q=${encodeURIComponent(target.creds.email)}`,
    {},
    plain.token,
  );
  check("lookup does NOT match on email", (byEmail.body?.users?.length ?? 0) === 0,
    `${byEmail.body?.users?.length ?? 0} results`);

  const excludeSelf = await req(
    `/lookup/users?q=${encodeURIComponent(plain.creds.username.slice(0, 8))}&excludeSelf=true`,
    {},
    plain.token,
  );
  check("lookup can exclude the caller",
    !excludeSelf.body?.users?.some((u) => u.id === plain.user.id));

  const anon = await fetch(`${BASE}/api/lookup/users?q=test`);
  check("lookup requires authentication", anon.status === 401, `got ${anon.status}`);

  const serverLookup = await req(`/lookup/servers?q=zzzz-no-such-server`, {}, plain.token);
  check("server lookup responds and is scoped to membership",
    serverLookup.status === 200 && serverLookup.body?.servers?.length === 0);

  // --- brand kit ---
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("brand kit test")], { type: "text/plain" }), "palette.txt");
  const upload = await fetch(`${BASE}/api/master/brand-kit`, {
    method: "POST",
    headers: { authorization: `Bearer ${MASTER_TOKEN}` },
    body: form,
  });
  check("master can upload a brand asset", upload.status === 200, `got ${upload.status}`);

  const listed = await req("/master/brand-kit");
  check("uploaded asset appears in the listing",
    listed.body?.files?.some((f) => f.fileName === "palette.txt"),
    `${listed.body?.files?.length ?? 0} files`);

  const badForm = new FormData();
  badForm.append("file", new Blob([Buffer.from("#!/bin/sh")], { type: "text/plain" }), "evil.sh");
  const badUpload = await fetch(`${BASE}/api/master/brand-kit`, {
    method: "POST",
    headers: { authorization: `Bearer ${MASTER_TOKEN}` },
    body: badForm,
  });
  check("unsupported brand-kit file type rejected", badUpload.status === 400, `got ${badUpload.status}`);

  const plainUpload = await fetch(`${BASE}/api/master/brand-kit`, {
    method: "POST",
    headers: { authorization: `Bearer ${plain.token}` },
    body: new FormData(),
  });
  check("non-master cannot upload brand assets (403)", plainUpload.status === 403,
    `got ${plainUpload.status}`);

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
