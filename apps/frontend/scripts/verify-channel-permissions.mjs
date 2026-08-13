// Verifies per-channel permission overwrites (parity Phase 7) against the live deployment.
//
// Written entirely against the API. Every property here is a server rule, and a UI test would pass
// against a broken implementation for the wrong reason: if a private channel is still readable,
// the sidebar just doesn't render a link to it, and clicking nothing proves nothing. What matters
// is whether the messages come back over HTTP to someone who was configured not to see them.
//
// The structure throughout is deny-then-prove: every "B cannot see it" assertion is preceded by a
// "B can see it" assertion in the same run, so a blanket failure (bad token, broken invite, empty
// server) cannot be mistaken for the access control working.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0,
  fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

const P = {
  VIEW_CHANNELS: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  ADMINISTRATOR: 1n << 15n,
};

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
    /* 204s have no body */
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
  const owner = await register(`qq_perm_owner_${rand}`);
  const member = await register(`qq_perm_member_${rand}`);
  ok("registered an owner and a member");

  // ---- setup: a server, a secret channel with a message in it, and a joined member
  const server = (await api("/servers", { method: "POST", token: owner, body: { name: "Perm Verify" } })).json;
  const secret = (
    await api(`/servers/${server.id}/channels`, {
      method: "POST",
      token: owner,
      body: { name: "secret-plans", type: "TEXT" },
    })
  ).json;

  const marker = `zebrafish${rand}`;
  await api(`/channels/${secret.id}/messages`, { method: "POST", token: owner, body: { content: `topsecret ${marker}` } });

  const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: owner, body: {} })).json;
  await api(`/invites/${invite.code}/join`, { method: "POST", token: member });
  ok("member joined the server via invite");

  const roles = (await api(`/servers/${server.id}/roles`, { token: owner })).json;
  const everyone = roles.find((r) => r.isDefault);
  if (!everyone) throw new Error("no @everyone role found");

  // ---- positive controls, before any overwrite exists
  {
    const list = (await api(`/servers/${server.id}/channels`, { token: member })).json;
    list.some((c) => c.id === secret.id)
      ? ok("[control] member sees the channel before any overwrite")
      : bad("[control] member could not see the channel even before an overwrite — later denials prove nothing");

    const msgs = await api(`/channels/${secret.id}/messages`, { token: member });
    msgs.status === 200
      ? ok("[control] member can read the channel before any overwrite")
      : bad(`[control] member could not read the channel before an overwrite (${msgs.status})`);

    const search = await api(`/servers/${server.id}/search?q=${marker}`, { token: member });
    (search.json ?? []).length > 0
      ? ok("[control] member can find the message by search before any overwrite")
      : bad("[control] search found nothing before any overwrite — the search assertions below prove nothing");
  }

  // ---- deny @everyone VIEW_CHANNELS
  {
    const res = await api(`/channels/${secret.id}/overwrites/${everyone.id}`, {
      method: "PUT",
      token: owner,
      body: { targetType: "ROLE", allow: "0", deny: P.VIEW_CHANNELS.toString() },
    });
    res.status === 200 ? ok("owner denied @everyone View Channel") : bad(`could not set the overwrite (${res.status})`, res.text.slice(0, 160));
  }

  {
    const list = (await api(`/servers/${server.id}/channels`, { token: member })).json;
    list.some((c) => c.id === secret.id)
      ? bad("the channel is STILL in the member's channel list after the deny")
      : ok("the channel disappeared from the member's channel list");
  }

  {
    const msgs = await api(`/channels/${secret.id}/messages`, { token: member });
    if (msgs.status === 200) bad("the member can STILL read the hidden channel's messages");
    else if (msgs.status === 404) ok("reading the hidden channel answers 404 (does not confirm it exists)");
    else bad(`reading the hidden channel answered ${msgs.status}, expected 404 — a 403 confirms the channel exists`);
  }

  {
    const send = await api(`/channels/${secret.id}/messages`, { method: "POST", token: member, body: { content: "hello?" } });
    send.status >= 400 ? ok(`posting to the hidden channel is refused (${send.status})`) : bad("the member could POST to the hidden channel");
  }

  {
    // The leak that makes "private channel" meaningless if it is missed: full-text search runs
    // against Message directly and never passes through a channel permission check of its own.
    const search = await api(`/servers/${server.id}/search?q=${marker}`, { token: member });
    (search.json ?? []).length === 0
      ? ok("search no longer returns the hidden channel's message")
      : bad("SEARCH LEAKS the hidden channel's message content");
  }

  {
    // The owner must never be locked out by an overwrite — ownership bypasses them entirely.
    const list = (await api(`/servers/${server.id}/channels`, { token: owner })).json;
    list.some((c) => c.id === secret.id)
      ? ok("the owner still sees the channel (ownership bypasses overwrites)")
      : bad("the owner locked themselves out of their own channel");
  }

  // ---- a role allow re-grants access over the @everyone deny
  {
    const role = (
      await api(`/servers/${server.id}/roles`, {
        method: "POST",
        token: owner,
        body: { name: "Insiders", permissions: "0" },
      })
    ).json;
    const me = (await api("/auth/me", { token: member })).json;
    await api(`/servers/${server.id}/members/${me.id}/roles/${role.id}`, { method: "POST", token: owner });

    const res = await api(`/channels/${secret.id}/overwrites/${role.id}`, {
      method: "PUT",
      token: owner,
      body: { targetType: "ROLE", allow: P.VIEW_CHANNELS.toString(), deny: "0" },
    });
    if (res.status !== 200) bad(`could not set the role overwrite (${res.status})`, res.text.slice(0, 160));

    const list = (await api(`/servers/${server.id}/channels`, { token: member })).json;
    list.some((c) => c.id === secret.id)
      ? ok("a role allow re-grants access over the @everyone deny")
      : bad("the role allow did not override the @everyone deny");

    const search = await api(`/servers/${server.id}/search?q=${marker}`, { token: member });
    (search.json ?? []).length > 0
      ? ok("search returns the message again once access is restored")
      : bad("search still hides the message after access was restored");
  }

  // ---- escalation and coherence guards
  {
    const res = await api(`/channels/${secret.id}/overwrites/${everyone.id}`, {
      method: "PUT",
      token: owner,
      body: { targetType: "ROLE", allow: P.ADMINISTRATOR.toString(), deny: "0" },
    });
    res.status === 400
      ? ok("granting Administrator in a channel overwrite is refused")
      : bad(`Administrator was accepted in an overwrite (${res.status}) — that is server-wide authority via a channel`);
  }

  {
    const res = await api(`/channels/${secret.id}/overwrites/${everyone.id}`, {
      method: "PUT",
      token: owner,
      body: { targetType: "ROLE", allow: P.SEND_MESSAGES.toString(), deny: P.SEND_MESSAGES.toString() },
    });
    res.status === 400
      ? ok("allowing and denying the same permission is refused")
      : bad(`a contradictory overwrite was accepted (${res.status})`);
  }

  {
    const res = await api(`/channels/${secret.id}/overwrites`, { token: member });
    res.status >= 400
      ? ok(`a member without Manage Roles cannot read the overwrite list (${res.status})`)
      : bad("a plain member could read the channel's overwrite configuration");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
