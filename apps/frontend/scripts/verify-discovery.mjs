// Verifies the Discover surface AND the server-settings persistence fix, live.
//
// The settings check matters most: PATCH /servers/:id validated sixteen fields and persisted
// five, so the Moderation and Community tabs were silent no-ops. The check here is
// write-then-READ-BACK — asserting on the PATCH response alone would pass against a handler that
// echoes input without saving it.
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

function birthDate(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function register(username, years, bracket) {
  const res = await api("/auth/register", {
    method: "POST",
    body: { username, email: `${username}@example.com`, password: "password123", birthDate: birthDate(years), ageBracket: bracket },
  });
  if (res.status !== 201) throw new Error(`register ${username}: ${res.status} ${res.text.slice(0, 160)}`);
  return res.json.accessToken;
}

async function main() {
  const owner = await register(`qq_disc_owner_${rand}`, 30, "AGE_25_34");
  const joiner = await register(`qq_disc_join_${rand}`, 40, "AGE_35_49");
  const minor = await register(`qq_disc_minor_${rand}`, 16, "UNDER_18");
  ok("registered owner, joiner, minor");

  // ---------------------------------------------------------------- the settings persistence fix
  const server = (await api("/servers", { method: "POST", token: owner, body: { name: "Disc Verify" } })).json;
  {
    const patch = await api(`/servers/${server.id}`, {
      method: "PATCH",
      token: owner,
      body: { description: "a place for verifying", verificationLevel: "HIGH", sysLeaveMessages: true },
    });
    if (patch.status !== 200) bad(`settings PATCH failed (${patch.status})`, patch.text.slice(0, 120));

    const back = (await api(`/servers/${server.id}`, { token: owner })).json;
    back.description === "a place for verifying"
      ? ok("description SAVES and reads back (was silently dropped)")
      : bad(`description did not persist (got ${JSON.stringify(back.description)})`);
    back.verificationLevel === "HIGH"
      ? ok("verificationLevel saves and reads back")
      : bad(`verificationLevel did not persist (got ${back.verificationLevel})`);
    back.sysLeaveMessages === true
      ? ok("sysLeaveMessages saves and reads back")
      : bad("sysLeaveMessages did not persist");
  }

  // ---------------------------------------------------------------- discovery gating
  {
    const res = await api("/discovery", { token: minor });
    res.status === 403 ? ok("a minor is refused the Discover surface (403)") : bad(`minor reached discovery (${res.status})`);
  }

  {
    // Not discoverable yet — must be absent even though it exists.
    const d = (await api("/discovery", { token: joiner })).json;
    const listed = [...(d.newServers ?? []), ...(d.popularServers ?? [])].some((s) => s.id === server.id);
    listed ? bad("a server appeared in Discover WITHOUT opting in") : ok("[control] an unlisted server stays unlisted");
  }

  {
    const toggle = await api(`/servers/${server.id}`, { method: "PATCH", token: owner, body: { discoverable: true } });
    toggle.json?.discoverable === true ? ok("owner can opt the server into Discover") : bad(`discoverable did not save (${toggle.status})`);
  }

  {
    const d = (await api("/discovery", { token: joiner })).json;
    const listed = [...(d.newServers ?? []), ...(d.popularServers ?? [])].some((s) => s.id === server.id);
    listed ? ok("an opted-in server appears in Discover") : bad("the discoverable server is not listed");

    Array.isArray(d.people) && d.people.length > 0
      ? ok(`the people panel has ${d.people.length} adult(s)`)
      : bad("the people panel is empty");
    d.people.some((u) => u.username === `qq_disc_minor_${rand}`)
      ? bad("A MINOR APPEARS IN THE PEOPLE PANEL")
      : ok("no minor appears in the people panel");
    typeof d.rotatesAt === "string" ? ok("the response says when it rotates") : bad("no rotatesAt in response");
  }

  // ---------------------------------------------------------------- inviteless join
  {
    const join = await api(`/discovery/servers/${server.id}/join`, { method: "POST", token: joiner });
    join.status === 201 ? ok("an adult can join a discoverable server without an invite") : bad(`join failed (${join.status})`, join.text.slice(0, 120));

    const mine = (await api("/servers", { token: joiner })).json;
    (mine ?? []).some((s) => s.id === server.id)
      ? ok("the joined server shows in the joiner's server list")
      : bad("join did not create a visible membership");
  }

  {
    // Turning discovery off closes the open door immediately, even with the id in hand.
    await api(`/servers/${server.id}`, { method: "PATCH", token: owner, body: { discoverable: false } });
    const third = await register(`qq_disc_late_${rand}`, 25, "AGE_25_34");
    const join = await api(`/discovery/servers/${server.id}/join`, { method: "POST", token: third });
    join.status === 404
      ? ok("un-listing closes inviteless join with a 404 (no existence leak)")
      : bad(`a de-listed server still answered ${join.status} to join`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
