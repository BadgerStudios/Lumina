// Verifies the minor-account regime against the live deployment: 16+ signup, locked-until-paired,
// adult/minor visibility separation, feature restrictions, parental supervision, and the
// per-child approved-contact bypass.
//
// API-driven throughout. Every claim here is a server rule, and a UI test would pass against a
// broken build for the wrong reason — if minors are still listed to adults, the sidebar simply
// renders whatever the API returned, and clicking nothing proves nothing.
//
// Positive controls are load-bearing: "the adult cannot see the minor" is also what a broken
// search endpoint looks like, so each hiding assertion is paired with a visibility assertion that
// must pass in the same run.
const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0,
  fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

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

/** Birth date exactly `years` old today, nudged by `days` to sit either side of a boundary. */
function birthDate(years, days = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function register(username, { years, bracket }) {
  return api("/auth/register", {
    method: "POST",
    body: {
      username,
      email: `${username}@example.com`,
      password: "password123",
      birthDate: birthDate(years),
      ageBracket: bracket,
    },
  });
}

async function main() {
  // ---------------------------------------------------------------- signup boundary
  {
    const tooYoung = await register(`qq_kid_${rand}`, { years: 14, bracket: "UNDER_18" });
    // 403, not merely ">= 400". A 429 from the register rate limit would otherwise satisfy this
    // and report the age floor as working when nothing about age had been evaluated at all.
    if (tooYoung.status === 429) bad("rate limited before the age floor could be tested; re-run in a minute");
    else if (tooYoung.status === 403) ok("a 14 year old is still refused (403)");
    else bad(`a 14 year old was not refused as expected (${tooYoung.status})`);
  }

  const minorRes = await register(`qq_minor_${rand}`, { years: 16, bracket: "UNDER_18" });
  if (minorRes.status !== 201) {
    bad(`a 16 year old could not register (${minorRes.status})`, minorRes.text.slice(0, 200));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  ok("a 16 year old CAN register (previously hard-blocked)");
  const minorToken = minorRes.json.accessToken;
  const minorId = minorRes.json.user.id;
  const minorUsername = `qq_minor_${rand}`;

  {
    const me = await api("/auth/me", { token: minorToken });
    me.json?.isMinor === true ? ok("the account is flagged as a minor") : bad("isMinor was not set");
  }

  {
    // The mis-click that blocked a real signup earlier today must still be held, not waved through.
    const mismatch = await register(`qq_mm_${rand}`, { years: 30, bracket: "UNDER_18" });
    mismatch.status >= 400
      ? ok("a bracket/birthdate disagreement across 18 is still refused")
      : bad("an adult date with a minor bracket was accepted");
  }

  // ---------------------------------------------------------------- locked until paired
  {
    const state = await api("/parental/me", { token: minorToken });
    state.json?.locked === true ? ok("a fresh minor account is locked") : bad("the minor account was not locked");
    state.json?.pairingCode ? ok("a pairing code is issued") : bad("no pairing code was issued");
  }

  const adultRes = await register(`qq_adult_${rand}`, { years: 30, bracket: "AGE_25_34" });
  if (adultRes.status !== 201) {
    // 429 here means the suite was run back-to-back with another that also registers accounts.
    // Worth naming explicitly — it looks exactly like a real failure otherwise.
    bad(`adult register failed (${adultRes.status})`, adultRes.status === 429 ? "rate limited; re-run in a minute" : adultRes.text.slice(0, 160));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const adultToken = adultRes.json.accessToken;
  const adultUsername = `qq_adult_${rand}`;

  const server = (await api("/servers", { method: "POST", token: adultToken, body: { name: "Parental Verify" } })).json;
  const invite = (await api(`/servers/${server.id}/invites`, { method: "POST", token: adultToken, body: {} })).json;

  {
    const join = await api(`/invites/${invite.code}/join`, { method: "POST", token: minorToken });
    join.status >= 400
      ? ok(`a locked minor cannot join a server (${join.status})`)
      : bad("a locked minor joined a server");
  }

  {
    const friend = await api("/friends/requests", {
      method: "POST",
      token: minorToken,
      body: { username: adultUsername },
    });
    friend.status >= 400
      ? ok(`a locked minor cannot send friend requests (${friend.status})`)
      : bad("a locked minor sent a friend request");
  }

  // ---------------------------------------------------------------- pairing
  const code = (await api("/parental/me", { token: minorToken })).json.pairingCode;

  {
    // A minor cannot supervise a minor — otherwise two children pair with each other and the
    // whole requirement evaporates.
    const secondMinor = await register(`qq_minor2_${rand}`, { years: 17, bracket: "UNDER_18" });
    if (secondMinor.status === 201) {
      const res = await api("/parental/redeem", { method: "POST", token: secondMinor.json.accessToken, body: { code } });
      res.status >= 400
        ? ok(`a minor cannot redeem another minor's pairing code (${res.status})`)
        : bad("a minor supervised another minor");
    }
  }

  {
    const res = await api("/parental/redeem", { method: "POST", token: adultToken, body: { code } });
    res.status === 200 ? ok("an adult can redeem the pairing code") : bad(`redeem failed (${res.status})`, res.text.slice(0, 160));
  }

  {
    const state = await api("/parental/me", { token: minorToken });
    state.json?.locked === false ? ok("the minor is unlocked once paired") : bad("still locked after pairing");
    state.json?.parent?.username === adultUsername
      ? ok("the child is told who supervises them")
      : bad("the child is not told who their parent is");
  }

  {
    const join = await api(`/invites/${invite.code}/join`, { method: "POST", token: minorToken });
    join.status < 400 ? ok("an unlocked minor can join a server") : bad(`unlocked minor still blocked (${join.status})`);
  }

  // ---------------------------------------------------------------- visibility separation
  const otherAdultRes = await register(`qq_adult2_${rand}`, { years: 40, bracket: "AGE_35_49" });
  const otherAdultToken = otherAdultRes.json.accessToken;
  await api(`/invites/${invite.code}/join`, { method: "POST", token: otherAdultToken });

  {
    // Positive control: the unrelated adult IS findable by the parent, so a zero result below
    // means "minor hidden" rather than "search broken".
    const res = await api(`/lookup/users?q=qq_adult2_${rand}`, { token: adultToken });
    (res.json?.users ?? []).some((u) => u.username === `qq_adult2_${rand}`)
      ? ok("[control] an adult can find another adult by search")
      : bad("[control] adult-to-adult search returned nothing — the hiding assertions prove nothing");
  }

  {
    const res = await api(`/lookup/users?q=${minorUsername}`, { token: otherAdultToken });
    (res.json?.users ?? []).some((u) => u.id === minorId)
      ? bad("AN ADULT CAN FIND A MINOR BY SEARCH")
      : ok("a minor does not appear in an unrelated adult's search");
  }

  {
    const res = await api(`/servers/${server.id}/members`, { token: otherAdultToken });
    // Array-checked, not `?? []`: an error body is an object, and `{}.some` throws rather than
    // failing the assertion — which aborts the run and hides every check after it.
    if (!Array.isArray(res.json)) bad(`member list did not return a list (${res.status})`, res.text.slice(0, 120));
    else if (res.json.some((m) => m.userId === minorId)) bad("A MINOR APPEARS IN AN ADULT'S MEMBER LIST");
    else ok("a minor does not appear in an adult's member list");
  }

  {
    // And the minor really is in that server — otherwise the two assertions above are vacuous.
    const res = await api(`/servers/${server.id}/members`, { token: minorToken });
    Array.isArray(res.json) && res.json.some((m) => m.userId === minorId)
      ? ok("[control] the minor really is a member of that server")
      : bad("[control] the minor is not in the server — the member-list assertion proves nothing");
  }

  // ---------------------------------------------------------------- feature restrictions
  for (const [label, path] of [
    ["the video feed", "/feed"],
    ["billing", "/billing/subscription"],
    ["the store catalogue", "/store/catalogue"],
  ]) {
    const res = await api(path, { token: minorToken });
    res.status >= 400 ? ok(`a minor is refused ${label} (${res.status})`) : bad(`a minor reached ${label}`);
  }

  {
    const res = await api("/store/catalogue", { token: adultToken });
    res.status < 400
      ? ok("[control] an adult can still reach the store")
      : bad(`[control] the store is broken for adults too (${res.status})`);
  }

  // ---------------------------------------------------------------- supervision
  {
    const contacts = await api(`/parental/children/${minorId}/contacts`, { token: adultToken });
    contacts.status === 200 ? ok("the parent can read the child's contact list") : bad(`contacts failed (${contacts.status})`);

    const servers = await api(`/parental/children/${minorId}/servers`, { token: adultToken });
    (servers.json ?? []).some((s) => s.server.id === server.id)
      ? ok("the parent sees the servers their child joined")
      : bad("the child's servers are not visible to the parent");
  }

  {
    const res = await api(`/parental/children/${minorId}/messages`, { token: otherAdultToken });
    res.status >= 400
      ? ok(`an unrelated adult cannot read a child's messages (${res.status})`)
      : bad("ANY ADULT CAN READ ANY CHILD'S MESSAGES");
  }

  // ---------------------------------------------------------------- approved-contact bypass
  {
    // Before approval, the unrelated adult cannot friend the minor.
    const before = await api("/friends/requests", {
      method: "POST",
      token: otherAdultToken,
      body: { username: minorUsername },
    });
    before.status >= 400
      ? ok("[control] an unapproved adult cannot friend the minor")
      : bad("[control] an unapproved adult could already friend the minor");

    await api(`/parental/children/${minorId}/approved`, {
      method: "POST",
      token: adultToken,
      body: { username: `qq_adult2_${rand}`, note: "aunt" },
    });

    const found = await api(`/lookup/users?q=${minorUsername}`, { token: otherAdultToken });
    (found.json?.users ?? []).some((u) => u.id === minorId)
      ? ok("an approved adult CAN now find the child")
      : bad("approval did not make the child findable");

    const after = await api("/friends/requests", {
      method: "POST",
      token: otherAdultToken,
      body: { username: minorUsername },
    });
    after.status < 400
      ? ok("an approved adult can contact the child")
      : bad(`approval did not permit contact (${after.status})`, after.text.slice(0, 160));
  }

  {
    // The scoping property: approving an adult for ONE child must not expose any other minor.
    const third = await register(`qq_minor3_${rand}`, { years: 16, bracket: "UNDER_18" });
    if (third.status === 201) {
      const res = await api(`/lookup/users?q=qq_minor3_${rand}`, { token: otherAdultToken });
      (res.json?.users ?? []).some((u) => u.username === `qq_minor3_${rand}`)
        ? bad("APPROVAL FOR ONE CHILD EXPOSED A DIFFERENT CHILD")
        : ok("approval is scoped to that one child only");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
