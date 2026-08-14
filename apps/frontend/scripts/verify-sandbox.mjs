// Live verification of the game-sandbox control plane end to end:
// owner creates a sandbox, sets a programmable spec, mints a scoped agent token, queues a start;
// a SIMULATED agent (standing in for the Lumina Game Agent on a user's machine) heartbeats,
// receives the queued command + spec, then reports ONLINE with a connect address; the Activity
// panel's public view then shows it up. Plus the security barrier: the agent token can reach
// NOTHING but its own agent endpoint.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + String(e).slice(0, 140) : "")), fail++);
async function api(path, { method = "GET", token, agent, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (agent) headers.authorization = `GameAgent ${agent}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
}
const birth = () => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 30); return d.toISOString().slice(0, 10); };

async function main() {
  const reg = await api("/auth/register", { method: "POST", body: { username: `qq_sbx_${rand}`, email: `qq_sbx_${rand}@example.com`, password: "password123", birthDate: birth(), ageBracket: "AGE_25_34" } });
  if (reg.status !== 201) { console.log("fatal register", reg.status); process.exit(1); }
  const owner = reg.json.accessToken;

  // ---- owner creates a sandbox and programs it
  const created = await api("/sandbox", { method: "POST", token: owner, body: { name: "My Modded SMP", kind: "minecraft" } });
  const id = created.json?.id;
  created.status === 201 && id ? ok("owner created a sandbox") : bad(`create answered ${created.status}`);

  const spec = await api(`/sandbox/${id}/spec`, { method: "PUT", token: owner, body: {
    serverType: "FABRIC", mcVersion: "1.20.1", memoryMb: 4096,
    mods: ["https://cdn.modrinth.com/example-mod.jar"], motd: "Lumina-hosted modded SMP",
  }});
  spec.status === 200 && spec.json?.spec?.serverType === "FABRIC" ? ok("owner programmed the sandbox spec (Fabric 1.20.1, a mod, 4GB)") : bad(`spec set answered ${spec.status}`);

  const tok = await api(`/sandbox/${id}/agent-token`, { method: "POST", token: owner });
  const agentToken = tok.json?.agentToken;
  agentToken?.startsWith("lga_") ? ok("owner minted a scoped agent token") : bad("no agent token");

  // ---- the security barrier: that agent token can reach NOTHING but its own agent endpoint
  const abuse1 = await api("/servers", { agent: agentToken });
  const abuse2 = await api("/sandbox", { agent: agentToken });
  const abuse3 = await api("/users/@me", { agent: agentToken });
  (abuse1.status === 401 && abuse2.status === 401 && abuse3.status === 401)
    ? ok("agent token is refused by every non-agent route (401) — cannot touch core systems")
    : bad(`agent token leaked into core routes (${abuse1.status}/${abuse2.status}/${abuse3.status})`);

  // ---- owner queues a start
  const cmd = await api(`/sandbox/${id}/command`, { method: "POST", token: owner, body: { command: "start" } });
  cmd.json?.queued === "start" ? ok("owner queued a start command") : bad(`queue answered ${cmd.status}`);

  // ---- SIMULATED AGENT: first heartbeat picks up the command + the owner's spec
  const hb1 = await api("/sandbox/agent/heartbeat", { agent: agentToken, method: "POST", body: { status: "STARTING" } });
  hb1.json?.command === "start" && hb1.json?.spec?.serverType === "FABRIC"
    ? ok("agent heartbeat received the queued 'start' AND the owner's spec")
    : bad(`agent heartbeat wrong (cmd=${hb1.json?.command}, type=${hb1.json?.spec?.serverType})`);

  // command must fire exactly once — the next heartbeat has no command
  const hb2 = await api("/sandbox/agent/heartbeat", { agent: agentToken, method: "POST", body: { status: "ONLINE", connectAddress: "play.example.net:25565", playerCount: 3, maxPlayers: 20, consoleTail: "Done (12.3s)! For help, type \"help\"" } });
  hb2.json?.command === null ? ok("the queued command fired exactly once (idempotent delivery)") : bad(`command repeated: ${hb2.json?.command}`);

  // ---- consumer/Activity view now shows it ONLINE with the connect address
  const pub = await api(`/sandbox/${id}/public`, { token: owner });
  pub.json?.online === true && pub.json?.connectAddress === "play.example.net:25565" && pub.json?.playerCount === 3
    ? ok(`Activity panel shows ONLINE @ ${pub.json.connectAddress} (${pub.json.playerCount} players)`)
    : bad(`public view wrong: ${JSON.stringify(pub.json).slice(0, 120)}`);

  // ---- a stranger cannot mint a token or command someone else's sandbox
  const reg2 = await api("/auth/register", { method: "POST", body: { username: `qq_sbx2_${rand}`, email: `qq_sbx2_${rand}@example.com`, password: "password123", birthDate: birth(), ageBracket: "AGE_25_34" } });
  const stranger = reg2.json.accessToken;
  const steal = await api(`/sandbox/${id}/command`, { method: "POST", token: stranger, body: { command: "stop" } });
  steal.status === 404 ? ok("a stranger cannot control another owner's sandbox (404)") : bad(`stranger command answered ${steal.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
