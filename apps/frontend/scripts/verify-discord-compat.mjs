// End-to-end verification of the Discord compatibility layer against the live deployment:
// REST discovery, gateway handshake (hello → identify → READY → GUILD_CREATE), and a message
// posted through the compat REST arriving back as a MESSAGE_CREATE dispatch — the full loop a
// real Discord bot library performs. Adversarial checks: bad token → close 4004, invalid
// snowflake → 404, no auth → 401.
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const COMPAT = `${BASE}/discord/api`;
const GATEWAY = `${BASE.replace(/^http/, "ws")}/discord/gateway`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

async function api(path, { method = "GET", token, bot, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (bot) headers.authorization = `Bot ${bot}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* empty */ }
  return { status: res.status, json };
}

function birthDate(years) { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString().slice(0, 10); }

async function main() {
  // ---- setup: a human, an application (bot), a server the bot joins
  const reg = await api("/auth/register", { method: "POST", body: { username: `qq_dc_${rand}`, email: `qq_dc_${rand}@example.com`, password: "password123", birthDate: birthDate(30), ageBracket: "AGE_25_34" } });
  if (reg.status !== 201) { console.log(`fatal: register ${reg.status}`); process.exit(1); }
  const human = { token: reg.json.accessToken, id: reg.json.user.id };
  const app = (await api("/applications", { method: "POST", token: human.token, body: { name: `qq compat bot ${rand}` } })).json;
  const server = (await api("/servers", { method: "POST", token: human.token, body: { name: "Compat Probe" } })).json;
  const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: human.token, body: {} })).json;
  const joined = await api(`/invites/${invite.code}/join`, { method: "POST", bot: app.botToken });
  joined.status < 300 ? ok("bot joined a server via a normal invite") : bad(`bot join answered ${joined.status}`);

  // ---- compat REST
  const me = await api(`${COMPAT}/users/@me`, { bot: app.botToken });
  me.status === 200 && /^\d+$/.test(me.json?.id ?? "") && me.json.bot === true
    ? ok(`/users/@me answers a Discord-shaped bot user (snowflake ${me.json.id})`)
    : bad(`/users/@me wrong (${me.status} ${JSON.stringify(me.json).slice(0, 80)})`);

  const noAuth = await api(`${COMPAT}/users/@me`);
  noAuth.status === 401 ? ok("compat REST refuses missing auth (401)") : bad(`no-auth answered ${noAuth.status}`);

  const gw = await api(`${COMPAT}/gateway/bot`, { bot: app.botToken });
  gw.status === 200 && gw.json?.url?.startsWith("ws") && gw.json.shards === 1
    ? ok(`/gateway/bot points at ${gw.json.url}`)
    : bad(`/gateway/bot wrong (${gw.status})`);

  const badSnow = await api(`${COMPAT}/channels/999999999999`, { bot: app.botToken });
  badSnow.status === 404 ? ok("an unknown snowflake answers 404, not a crash") : bad(`unknown snowflake answered ${badSnow.status}`);

  // v10 prefix variant (what discord.js actually calls)
  const v10 = await api(`${COMPAT}/v10/users/@me`, { bot: app.botToken });
  v10.status === 200 ? ok("the /v10 prefix variant answers identically") : bad(`v10 prefix answered ${v10.status}`);

  // ---- gateway: bad token first (fail-closed), then the real handshake
  await new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY);
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw));
      if (p.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: "Bot not-a-real-token", intents: 0 } }));
    });
    ws.on("close", (code) => {
      code === 4004 ? ok("gateway closes 4004 on a bad token") : bad(`bad-token close code ${code}`);
      resolve();
    });
    setTimeout(() => { ws.close(); resolve(); }, 8000);
  });

  await new Promise((resolve) => {
    const ws = new WebSocket(GATEWAY);
    let sawReady = false, sawGuild = false, sawMessage = false, heartbeatAcked = false;
    const finish = () => { ws.close(); resolve(); };
    const timer = setTimeout(() => {
      if (!sawReady) bad("no READY within 15s");
      else if (!sawGuild) bad("no GUILD_CREATE within 15s");
      else if (!sawMessage) bad("no MESSAGE_CREATE within 15s");
      finish();
    }, 15000);

    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw));
      if (p.op === 10) {
        ws.send(JSON.stringify({ op: 1, d: null }));
        ws.send(JSON.stringify({ op: 2, d: { token: `Bot ${app.botToken}`, intents: 33280, properties: { os: "linux", browser: "verify", device: "verify" } } }));
      }
      if (p.op === 11) heartbeatAcked = true;
      if (p.t === "READY") {
        sawReady = true;
        p.d?.user?.bot && Array.isArray(p.d?.guilds)
          ? ok(`gateway READY (session ${p.d.session_id}, ${p.d.guilds.length} guild(s))`)
          : bad("READY payload malformed");
      }
      if (p.t === "GUILD_CREATE") {
        if (!sawGuild) {
          sawGuild = true;
          Array.isArray(p.d?.channels) && Array.isArray(p.d?.roles) && /^\d+$/.test(p.d.id)
            ? ok(`GUILD_CREATE carries channels+roles (guild ${p.d.id}, ${p.d.channels.length} channels)`)
            : bad("GUILD_CREATE payload malformed");
          // Now speak: post through compat REST into the first text channel; expect the dispatch.
          const textChannel = p.d.channels.find((c) => c.type === 0);
          if (!textChannel) { bad("no text channel in GUILD_CREATE"); clearTimeout(timer); finish(); return; }
          void api(`${COMPAT}/channels/${textChannel.id}/messages`, { method: "POST", bot: app.botToken, body: { content: `compat says hi ${rand}` } }).then((res) => {
            res.status === 200 && res.json?.id && res.json?.author?.bot
              ? ok("compat REST posted a message and returned a Discord-shaped object")
              : bad(`compat message create answered ${res.status}`);
          });
        }
      }
      if (p.t === "MESSAGE_CREATE" && p.d?.content === `compat says hi ${rand}`) {
        sawMessage = true;
        heartbeatAcked ? ok("heartbeat was ACKed (op 11)") : bad("no heartbeat ACK seen");
        ok("the posted message came back as a MESSAGE_CREATE dispatch — full loop closed");
        clearTimeout(timer);
        finish();
      }
    });
    ws.on("error", (e) => { bad("gateway socket error", String(e)); clearTimeout(timer); resolve(); });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
