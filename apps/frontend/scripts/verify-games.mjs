// Verifies the game platform and Activities against the live deployment.
//
// The Mojang checks hit the real public API on purpose — a mock proving we can parse our own
// fixtures would say nothing about the integration. "Notch" is used because that profile's UUID
// is famous, stable, and will outlive this script.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0,
  fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);
const NOTCH_UUID = "069a79f444e94726a5befca90e38aaf5";

async function api(path, { method = "GET", token, botToken, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (botToken) headers.authorization = `Bot ${botToken}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json, text };
}

async function register(username) {
  const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 30);
  const res = await api("/auth/register", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "password123", birthDate: d.toISOString().slice(0, 10), ageBracket: "AGE_25_34" },
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${res.text.slice(0, 160)}`);
  return res.json.accessToken;
}

async function main() {
  const user = await register(`qq_game_${rand}`);
  ok("registered");

  // ---------------------------------------------------------------- Minecraft identity
  let verifyCode = null;
  {
    const res = await api("/game/minecraft/link", { method: "POST", token: user, body: { username: "Notch" } });
    if (res.status !== 201) bad(`link failed (${res.status})`, res.text.slice(0, 160));
    else {
      res.json.externalId === NOTCH_UUID
        ? ok("linking resolves the real Mojang UUID")
        : bad(`wrong uuid: ${res.json.externalId}`);
      res.json.verified === false ? ok("a fresh link is unverified (claimed, not proven)") : bad("link born verified");
      verifyCode = res.json.verifyCode;
      verifyCode ? ok("a verify code is issued to the owner") : bad("no verify code");
      if (res.json.skinUrl) {
        const skin = await fetch(`${BASE}${res.json.skinUrl}`);
        skin.ok && (skin.headers.get("content-type") ?? "").includes("image/png")
          ? ok("the skin is cached on OUR origin and served as image/png (nginx + static both wired)")
          : bad(`skin serve broken (${skin.status} ${skin.headers.get("content-type")})`);
      } else bad("no skin cached for a profile known to have one");
    }
  }

  {
    const res = await api("/game/minecraft/link", { method: "POST", token: user, body: { username: "xx__no_such_user__xx" } });
    res.status >= 400 ? ok("a nonexistent Minecraft name is refused") : bad("garbage name accepted");
  }

  // ---------------------------------------------------------------- plugin verification (bot API)
  {
    const app = (await api("/applications", { method: "POST", token: user, body: { name: `PluginSim ${rand}` } })).json;
    const wrong = await api("/game/minecraft/verify", {
      method: "POST", botToken: app.botToken, body: { code: verifyCode, uuid: "11111111111111111111111111111111" },
    });
    wrong.status >= 400
      ? ok("verify with a mismatched in-game UUID is refused — a code alone proves nothing")
      : bad("VERIFY ACCEPTED THE WRONG PLAYER");

    const right = await api("/game/minecraft/verify", {
      method: "POST", botToken: app.botToken, body: { code: verifyCode, uuid: NOTCH_UUID },
    });
    right.json?.verified === true
      ? ok("a bot (the plugin) verifies the link when code and observed UUID match")
      : bad(`verify failed (${right.status})`, right.text.slice(0, 120));

    const links = (await api("/game/links", { token: user })).json;
    links?.[0]?.verified === true ? ok("the link now reads verified") : bad("verified flag did not stick");

    // ------------------------------------------------------------ Activities on the same app
    const act = await api(`/applications/${app.id}/activities`, {
      method: "POST", token: user, body: { name: "Test Arcade", url: "https://example.com/arcade" },
    });
    act.status === 201 ? ok("an activity registers on the application") : bad(`activity create failed (${act.status})`, act.text.slice(0, 120));

    const http = await api(`/applications/${app.id}/activities`, {
      method: "POST", token: user, body: { name: "Insecure", url: "http://example.com/x" },
    });
    http.status >= 400 ? ok("a plain-http activity URL is refused") : bad("HTTP ACTIVITY ACCEPTED — injection surface");

    const catalogue = (await api("/activities", { token: user })).json;
    (catalogue ?? []).some((a) => a.name === "Test Arcade")
      ? ok("the activity appears in the launcher catalogue")
      : bad("registered activity missing from catalogue");

    const other = await register(`qq_game2_${rand}`);
    const foreign = await api(`/activities/${act.json.id}`, { method: "DELETE", token: other });
    foreign.status >= 400 ? ok("someone else cannot delete your activity") : bad("FOREIGN ACTIVITY DELETE ALLOWED");
  }

  // ---------------------------------------------------------------- server status + SSRF guard
  {
    const server = (await api("/servers", { method: "POST", token: user, body: { name: "MC Verify" } })).json;
    const set = await api(`/servers/${server.id}`, { method: "PATCH", token: user, body: { minecraftHost: "169.254.169.254:25565" } });
    if (set.status !== 200) bad(`could not set minecraftHost (${set.status})`);
    const metadata = await api(`/game/minecraft/status/${server.id}`, { token: user });
    metadata.status === 400
      ? ok("pinging the cloud-metadata address is refused (SSRF guard holds on raw TCP)")
      : bad(`metadata address answered ${metadata.status} — TCP SSRF GUARD MISSING`);

    await api(`/servers/${server.id}`, { method: "PATCH", token: user, body: { minecraftHost: "definitely-not-real-xyz123.example:25565" } });
    const gone = await api(`/game/minecraft/status/${server.id}`, { token: user });
    gone.json?.online === false
      ? ok("an unresolvable host reports offline instead of erroring")
      : bad(`unresolvable host answered ${gone.status}: ${gone.text.slice(0, 80)}`);

    // Positive control against a real public server — network-dependent, so a miss is a WARN,
    // not a FAIL: this script must not go red because Hypixel had a bad minute.
    await api(`/servers/${server.id}`, { method: "PATCH", token: user, body: { minecraftHost: "mc.hypixel.net" } });
    const real = await api(`/game/minecraft/status/${server.id}`, { token: user });
    if (real.json?.online === true && typeof real.json.playersOnline === "number") {
      ok(`[control] a real public server answers the ping (${real.json.playersOnline} players on Hypixel)`);
    } else {
      console.log("WARN: could not reach a public Minecraft server for the positive control — guard checks above still stand");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
