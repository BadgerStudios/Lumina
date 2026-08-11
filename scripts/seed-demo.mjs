// Re-seeds the demo server used for marketing screenshots. Run before re-shooting so the shots
// never contain a real user's name or messages. Delete the accounts afterwards.

// Seeds a self-contained demo server with invented content, purely so the marketing screenshots
// never contain a real user's name or message. Everything created here is labelled and removable.
const BASE = "https://lumina.badgerstudios.net/api";
const pw = "demo-showcase-pw-1";
const stamp = Date.now();

async function call(path, { token, body, method = "POST" } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

async function makeUser(name, displayName) {
  const u = `${name}_${stamp}`;
  const r = await call("/auth/register", {
    body: { username: u, email: `${u}@example.com`, password: pw, displayName,
            ageBracket: "AGE_25_34", birthDate: "1994-06-15" },
  });
  return { username: u, token: r.body.accessToken, id: r.body.user?.id };
}

const host = await makeUser("demo_ava", "Ava Reyes");
const guest1 = await makeUser("demo_kai", "Kai Nakamura");
const guest2 = await makeUser("demo_iris", "Iris Bello");
console.log("users:", host.username, guest1.username, guest2.username);

const server = await call("/servers", { token: host.token, body: { name: "Studio Northwind" } });
const serverId = server.body.id;
const channels = await call(`/servers/${serverId}/channels`, { token: host.token, method: "GET" });
const general = channels.body.find((c) => c.type === "TEXT");
console.log("server:", serverId, "channel:", general?.id);

const invite = await call(`/servers/${serverId}/invites`, { token: host.token, body: {} });
for (const g of [guest1, guest2]) {
  await call(`/invites/${invite.body.code}/join`, { token: g.token, body: {} });
}

const script = [
  [host, "Morning — pushing the new colour pass to staging in about an hour."],
  [guest1, "Nice. Did the export bug get sorted?"],
  [host, "Yeah, it was the alpha channel getting flattened on save."],
  [guest2, "That explains the halos on everything I rendered yesterday 😅"],
  [guest1, "I'll re-run the batch once staging is up."],
  [host, "Perfect. I'll drop a note here when it's live."],
];
for (const [who, content] of script) {
  await call(`/channels/${general.id}/messages`, { token: who.token, body: { content } });
  await new Promise((r) => setTimeout(r, 120));
}
console.log("seeded", script.length, "messages");
console.log(JSON.stringify({ host: host.username, serverId, channelId: general.id, pw }));
