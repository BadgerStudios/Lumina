// Socket-level proof of the Go Live roster broadcast: two users join a voice channel, one
// announces a screen stream, BOTH rosters (in-call and server-wide) must carry streaming:"screen",
// and stopping must clear it. Also: an illegal kind must never appear in the roster.
import { io } from "socket.io-client";
const BASE = "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m) => (console.log("FAIL: " + m), fail++);

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
}
function birthDate(years) { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString().slice(0, 10); }
async function register(u) {
  const r = await api("/auth/register", { method: "POST", body: { username: u, email: `${u}@example.com`, password: "password123", birthDate: birthDate(30), ageBracket: "AGE_25_34" } });
  if (r.status !== 201) throw new Error(`register ${r.status}`);
  return { token: r.json.accessToken, id: r.json.user.id };
}
const connect = (token) => new Promise((resolve, reject) => {
  const s = io(BASE, { path: "/socket.io", transports: ["websocket"], auth: (cb) => cb({ accessToken: token }) });
  s.on("connect", () => resolve(s));
  s.on("connect_error", reject);
  setTimeout(() => reject(new Error("socket connect timeout")), 8000);
});
const emitAck = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const nextRoster = (s, pred, ms = 6000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  const h = (p) => { if (pred(p)) { clearTimeout(t); s.off("voice:roster-update", h); resolve(p); } };
  s.on("voice:roster-update", h);
});

const a = await register(`qq_live_a_${rand}`);
const b = await register(`qq_live_b_${rand}`);
const server = (await api("/servers", { method: "POST", token: a.token, body: { name: "GoLive Probe" } })).json;
const channels = (await api(`/servers/${server.id}/channels`, { token: a.token })).json;
let voice = channels.find((c) => c.type === "VOICE");
if (!voice) voice = (await api(`/servers/${server.id}/channels`, { method: "POST", token: a.token, body: { name: "probe-voice", type: "VOICE" } })).json;
const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: a.token, body: {} })).json;
await api(`/invites/${invite.code}/join`, { method: "POST", token: b.token });

const sa = await connect(a.token), sb = await connect(b.token);
const ja = await emitAck(sa, "voice:join", { channelId: voice.id });
const jb = await emitAck(sb, "voice:join", { channelId: voice.id });
ja?.ok && jb?.ok ? ok("both users joined the voice channel") : bad(`voice join failed (${JSON.stringify(ja)} ${JSON.stringify(jb)})`);

// A goes live; B (in call, also in server room) must see streaming:"screen" for A.
const live = nextRoster(sb, (p) => p.channelId === voice.id && p.participants?.some((x) => x.userId === a.id && x.streaming === "screen"));
sa.emit("voice:stream-state", { kind: "screen" });
(await live) ? ok('going live broadcasts streaming:"screen" on the roster') : bad("no roster update carried the stream state");

// Illegal kind must be coerced to null, never echoed. Broadcasts from the PREVIOUS state change
// can still be in flight here, so don't judge the first roster that arrives — wait for the one
// where A's state is no longer "screen" (the coercion result), and fail hard only if a roster
// ever carries a value outside the legal set.
let sawIllegal = null;
const settled = nextRoster(sb, (p) => {
  const row = p.channelId === voice.id ? p.participants?.find((x) => x.userId === a.id) : null;
  if (!row) return false;
  if (row.streaming !== null && row.streaming !== "screen" && row.streaming !== "camera") {
    sawIllegal = row.streaming;
    return true;
  }
  return row.streaming === null;
}, 8000);
sa.emit("voice:stream-state", { kind: "malware<script>" });
const settledRoster = await settled;
if (sawIllegal !== null) bad(`illegal kind was echoed into the roster: ${JSON.stringify(sawIllegal)}`);
else if (settledRoster) ok("an illegal stream kind is coerced to null, not echoed");
else bad("no roster update arrived after the illegal-kind emit");

// Stop → cleared.
const stop = nextRoster(sb, (p) => p.channelId === voice.id && p.participants?.some((x) => x.userId === a.id && x.streaming === null));
sa.emit("voice:stream-state", { kind: "screen" });
await nextRoster(sb, (p) => p.participants?.some((x) => x.userId === a.id && x.streaming === "screen"));
sa.emit("voice:stream-state", { kind: null });
(await stop) ? ok("stopping the stream clears the badge for everyone") : bad("stream state was not cleared");

sa.close(); sb.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
