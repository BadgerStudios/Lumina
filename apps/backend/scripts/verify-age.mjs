/**
 * Age collection, the minor/adult contact separation, and the block-reason catalogue.
 * Requires STAFF_TOKEN (staff or above) for the catalogue checks.
 */
const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const STAFF_TOKEN = process.env.STAFF_TOKEN;

const results = [];
const check = (n, p, d = "") => {
  results.push({ n, p, d });
  console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
};

function isoYearsAgo(years, offsetDays = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function register(tag, ageBracket, birthDate) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const body = {
    username: `ag_${tag}_${stamp}`.slice(0, 30),
    email: `ag_${tag}_${stamp}@example.com`,
    password: "TestPassword123!",
    ...(ageBracket ? { ageBracket } : {}),
    ...(birthDate ? { birthDate } : {}),
  };
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), creds: body };
}

async function main() {
  // --- consistent signups succeed ---
  const adult = await register("adult", "AGE_25_34", isoYearsAgo(30));
  check("consistent adult signup succeeds", adult.status === 201, `got ${adult.status}`);

  const minor = await register("minor", "UNDER_18", isoYearsAgo(15));
  check("under-18 signup is refused (18+ platform)", minor.status === 403, `got ${minor.status}`);
  check("under-18 refusal uses AGE_UNDER_MINIMUM", minor.body?.reasonCode === "AGE_UNDER_MINIMUM",
    `code=${minor.body?.reasonCode}`);
  check("under-18 message says come back when eligible",
    /18 or over/i.test(String(minor.body?.error)), minor.body?.error);

  // --- claiming an adult bracket with a minor's birth date ---
  // Now that the platform is 18+, being under 18 is disqualifying on its own, so this resolves to
  // AGE_UNDER_MINIMUM rather than AGE_MISMATCH — the more fundamental refusal wins. The mismatch
  // branch is kept in checkAge() because it becomes live again if MINIMUM_AGE is ever lowered.
  const liar = await register("liar", "AGE_25_34", isoYearsAgo(14));
  check("claiming adult with a minor's birth date is blocked", liar.status === 403, `got ${liar.status}`);
  check("refusal is the under-18 code, not a mismatch",
    liar.body?.reasonCode === "AGE_UNDER_MINIMUM", `code=${liar.body?.reasonCode}`);

  const reverse = await register("rev", "UNDER_18", isoYearsAgo(30));
  check("claiming minor with an adult's birth date is also blocked", reverse.status === 403,
    `got ${reverse.status}`);

  // --- a mismatch WITHIN adulthood is tolerated, not punished ---
  const offByOne = await register("off", "AGE_25_34", isoYearsAgo(40));
  check("adult-band mis-tap is accepted, not blocked", offByOne.status === 201, `got ${offByOne.status}`);

  // --- under the minimum age ---
  const child = await register("child", "UNDER_18", isoYearsAgo(9));
  check("young child signup refused", child.status === 403, `got ${child.status}`);

  // --- boundary: exactly 18 today counts as an adult ---
  const exactly18 = await register("e18", "AGE_18_24", isoYearsAgo(18));
  check("exactly 18 today is treated as an adult", exactly18.status === 201, `got ${exactly18.status}`);

  // --- device signup cooldown, not a permanent ban ---
  const fp = `fpage_${Date.now()}`;
  async function registerWithDevice(tag, bracket, dob) {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-fingerprint": fp },
      body: JSON.stringify({
        username: `cd_${tag}_${stamp}`.slice(0, 30),
        email: `cd_${tag}_${stamp}@example.com`,
        password: "TestPassword123!",
        ageBracket: bracket,
        birthDate: dob,
      }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const underage = await registerWithDevice("under", "UNDER_18", isoYearsAgo(15));
  check("under-age attempt from a device is refused", underage.status === 403, `got ${underage.status}`);

  const retry = await registerWithDevice("retry", "AGE_25_34", isoYearsAgo(30));
  check("same device cannot immediately retry with an adult date", retry.status === 403,
    `got ${retry.status}`);
  check("retry is a cooldown, not a permanent ban",
    retry.body?.reasonCode === "AGE_SIGNUP_COOLDOWN", `code=${retry.body?.reasonCode}`);

  const cleanDevice = await register("clean", "AGE_25_34", isoYearsAgo(30));
  check("an unrelated device is unaffected", cleanDevice.status === 201, `got ${cleanDevice.status}`);

  // --- accounts with no age are treated as minors (safe default) ---
  const unknown = await register("unk");
  if (unknown.status === 201 && adult.status === 201) {
    const cross = await fetch(`${BASE}/api/friends/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${adult.body.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ username: unknown.creds.username }),
    });
    check("account with no age recorded is treated as a minor", cross.status === 403, `got ${cross.status}`);
  }

  // --- catalogue ---
  if (STAFF_TOKEN) {
    const cat = await fetch(`${BASE}/api/master/reasons`, {
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
    });
    const catBody = await cat.json();
    check("staff can read the reason catalogue", cat.status === 200, `got ${cat.status}`);
    check("catalogue contains the age codes",
      catBody.reasons?.some((r) => r.code === "AGE_MISMATCH") &&
        catBody.reasons?.some((r) => r.code === "DEVICE_BANNED"),
      `${catBody.reasons?.length} reasons`);

    const search = await fetch(`${BASE}/api/master/reasons?q=device`, {
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
    });
    const searchBody = await search.json();
    check("catalogue is searchable",
      searchBody.reasons?.length > 0 && searchBody.reasons.length < catBody.reasons.length,
      `${searchBody.reasons?.length} of ${catBody.reasons?.length}`);

    const flags = await fetch(`${BASE}/api/master/flags?code=AGE_MISMATCH`, {
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
    });
    const flagBody = await flags.json();
    check("mismatch attempts were recorded as flags", (flagBody.flags?.length ?? 0) > 0,
      `${flagBody.flags?.length} flags`);
    check("flags never expose identifier hashes",
      !JSON.stringify(flagBody).includes("ipHash") && !JSON.stringify(flagBody).includes("deviceHash"));

    const anon = await fetch(`${BASE}/api/master/reasons`);
    check("catalogue requires authentication", anon.status === 401, `got ${anon.status}`);
  } else {
    console.log("(skipping catalogue checks — no STAFF_TOKEN)");
  }

  const failed = results.filter((r) => !r.p);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  - ${f.n}${f.d ? ` (${f.d})` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exitCode = 1;
});
