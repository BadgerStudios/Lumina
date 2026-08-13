// Verifies threads (parity Phase 9) against the live deployment.
//
// API-driven: every property here is a server rule. The single most important one is that a thread
// inherits its PARENT channel's permission overwrites — a thread resolving against its own (empty)
// overwrite set would be public, so every private channel would leak the moment anyone started a
// thread in it. That case gets a positive control on both sides.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0,
  fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

const VIEW_CHANNELS = 1n << 0n;

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 */
  }
  return { status: res.status, json, text };
}

async function register(username) {
  const res = await api("/auth/register", {
    method: "POST",
    body: {
      username,
      email: `${username}@example.com`,
      password: "password123",
      birthDate: "1995-04-01",
      ageBracket: "AGE_25_34",
    },
  });
  if (res.status >= 400) throw new Error(`register ${username}: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.accessToken;
}

async function main() {
  const owner = await register(`qq_thr_owner_${rand}`);
  const member = await register(`qq_thr_member_${rand}`);

  const server = (await api("/servers", { method: "POST", token: owner, body: { name: "Thread Verify" } })).json;
  const channels = (await api(`/servers/${server.id}/channels`, { token: owner })).json;
  const general = channels.find((c) => c.type === "TEXT");
  const voice = channels.find((c) => c.type === "VOICE");

  const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: owner, body: {} })).json;
  await api(`/invites/${invite.code}/join`, { method: "POST", token: member });
  ok("set up a server with a member");

  // ---- creating a thread from a message
  const origin = (
    await api(`/channels/${general.id}/messages`, { method: "POST", token: owner, body: { content: "let's discuss" } })
  ).json;

  const created = await api(`/channels/${general.id}/threads`, {
    method: "POST",
    token: owner,
    body: { name: "Design chat", originMessageId: origin.id },
  });
  created.status === 201 ? ok("created a thread from a message") : bad(`create thread (${created.status})`, created.text.slice(0, 160));
  const thread = created.json;

  {
    // Idempotency: the second "create thread" on the same message must open the first, not make a
    // second one. Two people clicking a moment apart is the ordinary case, not an error.
    const again = await api(`/channels/${general.id}/threads`, {
      method: "POST",
      token: owner,
      body: { name: "Different name", originMessageId: origin.id },
    });
    again.json?.id === thread.id
      ? ok("a second thread on the same message returns the existing one")
      : bad(`a duplicate thread was created (${again.json?.id} vs ${thread.id})`);
  }

  {
    // The whole reason a thread is a Channel row: the ordinary message route must just work.
    const posted = await api(`/channels/${thread.id}/messages`, {
      method: "POST",
      token: member,
      body: { content: "sounds good" },
    });
    posted.status === 201
      ? ok("a thread accepts messages through the normal channel message route")
      : bad(`posting into the thread failed (${posted.status})`, posted.text.slice(0, 160));

    const read = await api(`/channels/${thread.id}/messages`, { token: member });
    (read.json ?? []).some((m) => m.content === "sounds good")
      ? ok("thread messages read back through the normal route")
      : bad("the thread message did not read back");
  }

  {
    const msgs = await api(`/channels/${general.id}/messages`, { token: member });
    const found = (msgs.json ?? []).find((m) => m.id === origin.id);
    found?.thread?.id === thread.id
      ? ok("the origin message carries its thread (drives the 'N replies' affordance)")
      : bad("the origin message does not reference its thread");
  }

  {
    const list = await api(`/channels/${general.id}/threads`, { token: member });
    (list.json ?? []).some((t) => t.id === thread.id)
      ? ok("the thread appears in the channel's active thread list")
      : bad("the thread is missing from the active list");
  }

  {
    // Threads must NOT leak into the sidebar channel list — they are Channel rows, so this is a
    // real thing to get wrong, and getting it wrong would put every thread ever created at the
    // top level of the sidebar.
    const list = await api(`/servers/${server.id}/channels`, { token: member });
    (list.json ?? []).some((c) => c.id === thread.id)
      ? bad("the thread leaked into the server's channel list")
      : ok("threads are excluded from the channel list");
  }

  // ---- membership
  {
    await api(`/threads/${thread.id}/members/@me`, { method: "PUT", token: member });
    const t = (await api(`/threads/${thread.id}`, { token: member })).json;
    t.joined === true ? ok("joining a thread is reflected in its DTO") : bad("join did not take effect");

    await api(`/threads/${thread.id}/members/@me`, { method: "DELETE", token: member });
    const t2 = (await api(`/threads/${thread.id}`, { token: member })).json;
    t2.joined === false ? ok("leaving a thread is reflected in its DTO") : bad("leave did not take effect");
  }

  // ---- archive lifecycle
  {
    const archived = await api(`/threads/${thread.id}/archive`, {
      method: "PATCH",
      token: owner,
      body: { archived: true },
    });
    archived.json?.archived === true ? ok("a thread can be archived") : bad(`archive failed (${archived.status})`);

    const active = await api(`/channels/${general.id}/threads?archived=false`, { token: owner });
    (active.json ?? []).some((t) => t.id === thread.id)
      ? bad("an archived thread is still in the active list")
      : ok("an archived thread leaves the active list");

    const archivedList = await api(`/channels/${general.id}/threads?archived=true`, { token: owner });
    (archivedList.json ?? []).some((t) => t.id === thread.id)
      ? ok("an archived thread appears in the archived list")
      : bad("the archived thread is in neither list");
  }

  {
    // Posting revives it. Without this, replying to an old thread is a dead end for a state the
    // user never chose and cannot see coming.
    await api(`/channels/${thread.id}/messages`, { method: "POST", token: member, body: { content: "reviving" } });
    await new Promise((r) => setTimeout(r, 600)); // the touch is fire-and-forget off the send path
    const t = (await api(`/threads/${thread.id}`, { token: owner })).json;
    t.archived === false ? ok("posting in an archived thread reopens it") : bad("posting did not revive the thread");
  }

  // ---- structural rules
  {
    const nested = await api(`/channels/${thread.id}/threads`, {
      method: "POST",
      token: owner,
      body: { name: "nested" },
    });
    nested.status === 400 ? ok("a thread inside a thread is refused") : bad(`nested thread accepted (${nested.status})`);
  }

  {
    const inVoice = await api(`/channels/${voice.id}/threads`, {
      method: "POST",
      token: owner,
      body: { name: "voice thread" },
    });
    inVoice.status === 400 ? ok("a thread in a voice channel is refused") : bad(`voice thread accepted (${inVoice.status})`);
  }

  // ---- THE important one: permission inheritance from the parent
  {
    const roles = (await api(`/servers/${server.id}/roles`, { token: owner })).json;
    const everyone = roles.find((r) => r.isDefault);

    // Positive control first: the member can reach the thread right now.
    const before = await api(`/threads/${thread.id}`, { token: member });
    before.status === 200
      ? ok("[control] the member can reach the thread before the parent is locked")
      : bad(`[control] member could not reach the thread beforehand (${before.status})`);

    await api(`/channels/${general.id}/overwrites/${everyone.id}`, {
      method: "PUT",
      token: owner,
      body: { targetType: "ROLE", allow: "0", deny: VIEW_CHANNELS.toString() },
    });

    const after = await api(`/threads/${thread.id}`, { token: member });
    after.status === 404
      ? ok("locking the PARENT channel hides its thread too (inheritance works)")
      : bad(`the thread is still reachable at ${after.status} after the parent was locked — PRIVATE CHANNELS LEAK VIA THREADS`);

    const msgs = await api(`/channels/${thread.id}/messages`, { token: member });
    msgs.status === 404
      ? ok("the thread's messages are unreadable once the parent is locked")
      : bad(`thread messages still readable at ${msgs.status} — CONTENT LEAK`);

    const owned = await api(`/threads/${thread.id}`, { token: owner });
    owned.status === 200 ? ok("the owner still reaches the thread") : bad("the owner lost access to their own thread");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
