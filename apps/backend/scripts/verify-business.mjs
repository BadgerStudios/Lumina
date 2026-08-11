/**
 * Billing scaffolding, download counting and bandwidth metering.
 * Runs against the real deployment. Requires OWNER_TOKEN.
 */
const BASE = process.env.BASE ?? "https://lumina.luxffa.com";
const OWNER_TOKEN = process.env.OWNER_TOKEN;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function register() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const body = {
    username: `bz_${stamp}`,
    email: `bz_${stamp}@example.com`,
    password: "TestPassword123!",
    ageBracket: "AGE_25_34", birthDate: "1995-06-15",
  };
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()).accessToken;
}

async function main() {
  if (!OWNER_TOKEN) throw new Error("OWNER_TOKEN required");
  const userToken = await register();

  // --- billing config, unconfigured ---
  const cfg = await get("/billing/config");
  check("billing config endpoint is public", cfg.status === 200, `got ${cfg.status}`);
  check("billing reports itself unconfigured (no keys set)", cfg.body?.configured === false,
    `configured=${cfg.body?.configured}`);
  check("plan catalogue is exposed", Array.isArray(cfg.body?.plans) && cfg.body.plans.length > 0);
  check("plans are marked unavailable without a price id",
    cfg.body?.plans?.every((p) => p.available === false));

  // --- checkout must fail cleanly, not 500 ---
  const checkout = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
    body: JSON.stringify({ planKey: "premium_monthly" }),
  });
  check("checkout fails with a clear 400 when unconfigured", checkout.status === 400,
    `got ${checkout.status}`);

  // --- webhook must never accept unsigned payloads ---
  const forged = await fetch(`${BASE}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "invoice.paid", data: { object: { amount_paid: 999999 } } }),
  });
  check("unsigned webhook payload is refused", forged.status === 503 || forged.status === 400,
    `got ${forged.status}`);

  const badSig = await fetch(`${BASE}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify({ type: "invoice.paid" }),
  });
  check("forged webhook signature is refused", badSig.status === 503 || badSig.status === 400,
    `got ${badSig.status}`);

  // --- user subscription status ---
  const sub = await get("/billing/subscription", userToken);
  check("subscription status reports inactive for a new user",
    sub.status === 200 && sub.body?.active === false);

  // --- owner business metrics ---
  const biz = await get("/owner/business", OWNER_TOKEN);
  check("owner can read business metrics", biz.status === 200, `got ${biz.status}`);
  check("revenue is flagged as not-configured rather than a fake zero",
    biz.body?.revenue?.configured === false, `configured=${biz.body?.revenue?.configured}`);
  check("revenue totals are zero with no transactions", biz.body?.revenue?.netCents === 0);
  check("revenue series covers 30 days", biz.body?.revenue?.series?.length === 30,
    `${biz.body?.revenue?.series?.length} points`);
  check("bandwidth series covers 30 days", biz.body?.bandwidth?.length === 30,
    `${biz.body?.bandwidth?.length} points`);
  check("download stats present", typeof biz.body?.downloads?.total === "number");

  const notOwner = await get("/owner/business", userToken);
  check("non-owner blocked from business metrics", notOwner.status === 403, `got ${notOwner.status}`);

  // --- counted downloads ---
  const before = (await get("/owner/business", OWNER_TOKEN)).body?.downloads?.total ?? 0;

  const dl = await fetch(`${BASE}/api/download/owner`);
  const bytes = (await dl.arrayBuffer()).byteLength;
  check("owner APK downloads via the counted route", dl.status === 200 && bytes > 100000,
    `${dl.status}, ${bytes} bytes`);
  check("download serves the APK content type",
    dl.headers.get("content-type")?.includes("android.package-archive") === true,
    dl.headers.get("content-type") ?? "");

  // The download route resolves a whitelist key, never a caller-supplied path, so traversal has
  // nothing to traverse. Asserted via a name that actually REACHES the route: a literal `../` in the
  // URL is normalised away by the HTTP client and nginx long before Fastify sees it, so testing with
  // one only ever exercises the SPA catch-all and proves nothing about this handler.
  const unknown = await fetch(`${BASE}/api/download/nonsense`);
  check("non-whitelisted download name is refused", unknown.status === 404, `got ${unknown.status}`);

  const traversal = await fetch(`${BASE}/api/download/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  const traversalBody = await traversal.text();
  check("traversal attempt leaks no file content", !traversalBody.includes("root:x:"),
    `${traversal.status}, ${traversalBody.length} bytes`);

  // Give the fire-and-forget insert a moment to land.
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await get("/owner/business", OWNER_TOKEN)).body?.downloads?.total ?? 0;
  check("download was counted", after > before, `${before} -> ${after}`);

  const platforms = (await get("/owner/business", OWNER_TOKEN)).body?.downloads?.byPlatform ?? [];
  check("download recorded against the owner-app platform",
    platforms.some((p) => p.platform === "android-owner"),
    JSON.stringify(platforms));

  // --- bandwidth metering ---
  const bwBefore = (await get("/owner/business", OWNER_TOKEN)).body?.bandwidth ?? [];
  const todayBefore = bwBefore[bwBefore.length - 1]?.download ?? 0;
  check("release download counted toward bandwidth", todayBefore >= bytes,
    `today download bytes=${todayBefore}, just fetched ${bytes}`);

  // --- the owner web bundle is actually served ---
  const ownerHtml = await fetch(`${BASE}/`);
  check("site still serves the main app", ownerHtml.status === 200, `got ${ownerHtml.status}`);

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
