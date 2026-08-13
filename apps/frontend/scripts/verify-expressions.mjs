// Verifies the seven message/server features added in this batch, against the live deployment:
// spoilers, stickers, polls, soundboard, link previews, slash commands and server templates.
//
// Written against the API rather than the UI wherever the property under test is a server rule
// (a sticker from another server must be refused; an SSRF target must never be fetched), because
// those are the ones a UI test can pass while the rule is broken — the button simply is not there
// to press. The browser is used only where the thing under test is genuinely a rendering question.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
const rand = Date.now();
let pass = 0,
  fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + e : "")), fail++);

async function api(path, { method = "GET", token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* some routes answer 204 with no body */
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

// ---------------------------------------------------------------- setup
const alice = `qq_ex_a_${rand}`;
const bob = `qq_ex_b_${rand}`;
const aliceToken = await register(alice);
const bobToken = await register(bob);
ok("registered two accounts");

const serverA = (await api("/servers", { method: "POST", token: aliceToken, body: { name: `qq_A_${rand}` } })).json;
const serverB = (await api("/servers", { method: "POST", token: aliceToken, body: { name: `qq_B_${rand}` } })).json;
const channels = (await api(`/servers/${serverA.id}/channels`, { token: aliceToken })).json;
const channel = channels.find((c) => c.type === "TEXT");
if (channel) ok("created two servers with a text channel");
else bad("no text channel in the new server");

// ---------------------------------------------------------------- stickers
const stickerPng = Buffer.from(
  // 1x1 transparent PNG.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function uploadSticker(serverId, name, token) {
  const form = new FormData();
  form.append("name", name);
  form.append("file", new Blob([stickerPng], { type: "image/png" }), "s.png");
  return api(`/servers/${serverId}/stickers`, { method: "POST", token, form });
}

const stickerA = await uploadSticker(serverA.id, `qq sticker ${rand}`, aliceToken);
if (stickerA.status < 400 && stickerA.json?.id) ok("uploaded a sticker");
else bad("sticker upload failed", `${stickerA.status} ${stickerA.text.slice(0, 200)}`);

const stickerB = await uploadSticker(serverB.id, `qq other ${rand}`, aliceToken);

// The image must actually be served. This is the exact bug custom emoji shipped with: the upload
// succeeded, the row existed, and the URL returned the SPA's index.html because no static route
// was registered for that directory.
if (stickerA.json?.imageUrl) {
  const img = await fetch(`${BASE}${stickerA.json.imageUrl}`);
  const type = img.headers.get("content-type") ?? "";
  if (img.ok && type.startsWith("image/")) ok(`sticker image served as ${type}`);
  else bad("sticker image is not served as an image", `${img.status} ${type}`);
}

// Same check for emoji, since that is where the bug was found.
const emojiForm = new FormData();
emojiForm.append("name", `qq${rand % 100000}`);
emojiForm.append("file", new Blob([stickerPng], { type: "image/png" }), "e.png");
const emoji = await api(`/servers/${serverA.id}/emojis`, { method: "POST", token: aliceToken, form: emojiForm });
if (emoji.json?.imageUrl) {
  const img = await fetch(`${BASE}${emoji.json.imageUrl}`);
  const type = img.headers.get("content-type") ?? "";
  if (img.ok && type.startsWith("image/")) ok(`custom emoji image served as ${type} (was 404 → index.html)`);
  else bad("custom emoji image still is not served", `${img.status} ${type}`);
} else {
  bad("emoji upload failed", emoji.text.slice(0, 200));
}

// A sticker from another server must not be postable here.
const crossServer = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "", stickerId: stickerB.json?.id },
});
if (crossServer.status === 403) ok("a sticker from another server is refused (403)");
else bad("cross-server sticker was accepted", String(crossServer.status));

const stickerSend = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "", stickerId: stickerA.json?.id },
});
if (stickerSend.status === 201 && stickerSend.json?.sticker?.id === stickerA.json.id) {
  ok("a sticker-only message sends and comes back with its sticker");
} else {
  bad("sticker send failed", `${stickerSend.status} ${stickerSend.text.slice(0, 200)}`);
}

// ---------------------------------------------------------------- polls
const pollMsg = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "pick one", poll: { question: "Tabs or spaces?", options: ["Tabs", "Spaces"], durationHours: 1 } },
});
if (pollMsg.status === 201 && pollMsg.json?.poll?.options?.length === 2) ok("a poll message sends");
else bad("poll send failed", `${pollMsg.status} ${pollMsg.text.slice(0, 200)}`);

const pollId = pollMsg.json?.poll?.id;
const optionId = pollMsg.json?.poll?.options?.[0]?.id;

const badPoll = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "", poll: { question: "One option only", options: ["Only"] } },
});
if (badPoll.status === 400) ok("a poll with one option is refused");
else bad("a one-option poll was accepted", String(badPoll.status));

const dupPoll = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "", poll: { question: "Dupes", options: ["Yes", "yes"] } },
});
if (dupPoll.status === 400) ok("a poll with two options that read the same is refused");
else bad("duplicate poll options were accepted", String(dupPoll.status));

if (pollId && optionId) {
  const vote = await api(`/polls/${pollId}/vote`, { method: "POST", token: aliceToken, body: { optionId } });
  if (vote.status === 200 && vote.json.totalVotes === 1 && vote.json.options[0].votedByMe) ok("voting works");
  else bad("vote failed", `${vote.status} ${vote.text.slice(0, 200)}`);

  // Clicking the same option again must retract, not double-count — the whole reason PollVote's
  // primary key is (optionId, userId).
  const again = await api(`/polls/${pollId}/vote`, { method: "POST", token: aliceToken, body: { optionId } });
  if (again.status === 200 && again.json.totalVotes === 0) ok("voting the same option again retracts it");
  else bad("re-voting did not retract", JSON.stringify(again.json?.totalVotes));

  // A non-member must not be able to vote in a poll inside a server they are not in.
  const outsider = await api(`/polls/${pollId}/vote`, { method: "POST", token: bobToken, body: { optionId } });
  if (outsider.status === 403 || outsider.status === 404) ok(`a non-member cannot vote (${outsider.status})`);
  else bad("a non-member voted in a private server's poll", String(outsider.status));
}

// ---------------------------------------------------------------- soundboard
// A file that is not audio must be refused, and the refusal must come from probing the file rather
// than from trusting the declared mime type.
const fakeAudio = new FormData();
fakeAudio.append("name", `qq fake ${rand}`);
fakeAudio.append("file", new Blob([stickerPng], { type: "audio/mpeg" }), "not-really.mp3");
const fake = await api(`/servers/${serverA.id}/sounds`, { method: "POST", token: aliceToken, form: fakeAudio });
if (fake.status === 400) ok("a PNG renamed to .mp3 is refused as a soundboard clip");
else bad("a non-audio file was accepted as a sound", `${fake.status} ${fake.text.slice(0, 160)}`);

const sounds = await api(`/servers/${serverA.id}/sounds`, { token: aliceToken });
if (sounds.status === 200 && Array.isArray(sounds.json)) ok("the soundboard list endpoint answers");
else bad("soundboard list failed", String(sounds.status));

// A non-member must not be able to read another server's soundboard.
const soundsOutsider = await api(`/servers/${serverA.id}/sounds`, { token: bobToken });
if (soundsOutsider.status === 403 || soundsOutsider.status === 404) {
  ok(`a non-member cannot list another server's sounds (${soundsOutsider.status})`);
} else {
  bad("a non-member read another server's soundboard", String(soundsOutsider.status));
}

// ---------------------------------------------------------------- link previews
// The important assertion is the negative one: a message linking an internal address must never
// produce a preview, and the row must record that it was blocked before any request left.
const ssrfTargets = ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:4000/healthz", "http://postgres:5432/"];
for (const target of ssrfTargets) {
  const msg = await api(`/channels/${channel.id}/messages`, {
    method: "POST",
    token: aliceToken,
    body: { content: `look at ${target}` },
  });
  if (msg.status !== 201) {
    bad(`sending a message containing ${target} failed`, String(msg.status));
    continue;
  }
  // Give the worker a moment, then re-read the message.
  await new Promise((r) => setTimeout(r, 2500));
  const list = await api(`/channels/${channel.id}/messages?limit=5`, { token: aliceToken });
  const stored = list.json?.find((m) => m.id === msg.json.id);
  if (stored && stored.embeds.length === 0) ok(`no preview produced for ${target}`);
  else bad(`a preview WAS produced for ${target}`, JSON.stringify(stored?.embeds));
}

// And the positive one, so the negative result above is not just "previews never work at all".
const publicMsg = await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "https://example.com/" },
});
let previewed = false;
for (let i = 0; i < 8 && !previewed; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const list = await api(`/channels/${channel.id}/messages?limit=5`, { token: aliceToken });
  const stored = list.json?.find((m) => m.id === publicMsg.json.id);
  if (stored?.embeds?.length > 0) previewed = true;
}
if (previewed) ok("a public URL does produce a preview (so the blocks above mean something)");
else bad("no preview for https://example.com — the negative results above prove nothing");

// ---------------------------------------------------------------- slash commands
const commands = await api(`/interactions/commands/server/${serverA.id}`, { token: aliceToken });
if (commands.status === 200 && Array.isArray(commands.json)) ok("the slash-command list endpoint answers");
else bad("slash-command list failed", `${commands.status} ${commands.text.slice(0, 160)}`);

// A human token must not be able to register commands — that is something an application does for
// itself, and the check is what stops one developer registering under another's application id.
const register = await api("/interactions/commands", {
  method: "PUT",
  token: aliceToken,
  body: [{ name: "hack", description: "should be refused" }],
});
if (register.status === 403) ok("a human token cannot register slash commands (403)");
else bad("a human token registered slash commands", String(register.status));

const unknown = await api("/interactions/invoke", {
  method: "POST",
  token: aliceToken,
  body: { channelId: channel.id, name: "definitely-not-a-command", options: {} },
});
if (unknown.status === 404) ok("invoking an unknown command is a clean 404");
else bad("unknown command did not 404", String(unknown.status));

// ---------------------------------------------------------------- templates
const template = await api("/templates", {
  method: "POST",
  token: aliceToken,
  body: { serverId: serverA.id, name: `qq template ${rand}` },
});
if (template.status === 201 && template.json?.code) ok("saved a server template");
else bad("template creation failed", `${template.status} ${template.text.slice(0, 200)}`);

// Someone with no permission in the source server must not be able to snapshot it.
const stolen = await api("/templates", {
  method: "POST",
  token: bobToken,
  body: { serverId: serverA.id, name: "nope" },
});
if (stolen.status === 403 || stolen.status === 404) ok(`a non-member cannot snapshot a server (${stolen.status})`);
else bad("a non-member snapshotted someone else's server", String(stolen.status));

if (template.json?.code) {
  const applied = await api(`/templates/${template.json.code}/apply`, {
    method: "POST",
    token: bobToken,
    body: { name: `qq applied ${rand}` },
  });
  if (applied.status === 201 && applied.json?.id) ok("applying a template creates a server");
  else bad("applying a template failed", `${applied.status} ${applied.text.slice(0, 200)}`);

  if (applied.json?.id) {
    const newChannels = await api(`/servers/${applied.json.id}/channels`, { token: bobToken });
    const sourceCount = channels.length;
    if (newChannels.json?.length === sourceCount) ok(`the applied server has the same ${sourceCount} channels`);
    else bad("channel count differs", `${newChannels.json?.length} vs ${sourceCount}`);

    // The permission clamp. Applying a template must never hand out ADMINISTRATOR.
    const newRoles = await api(`/servers/${applied.json.id}/roles`, { token: bobToken });
    const ADMINISTRATOR = 1n << 15n;
    const MANAGE_SERVER = 1n << 5n;
    const overreach = (newRoles.json ?? []).filter((r) => {
      const bits = BigInt(r.permissions);
      return (bits & ADMINISTRATOR) !== 0n || (bits & MANAGE_SERVER) !== 0n;
    });
    if (overreach.length === 0) ok("no applied role carries Administrator or Manage Server");
    else bad("an applied role carries an escalating permission", overreach.map((r) => r.name).join(", "));
  }
}

// ---------------------------------------------------------------- /metrics is not public
const metricsPublic = await fetch(`${BASE}/metrics`);
const metricsBody = await metricsPublic.text();
if (!metricsBody.includes("lumina_http_requests_total")) ok(`/metrics is not reachable from the internet (${metricsPublic.status})`);
else bad("/metrics is publicly readable");

// ---------------------------------------------------------------- spoilers, in a browser
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
page.on("pageerror", (e) => bad("uncaught page error", String(e)));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.getByLabel(/email or username/i).fill(alice);
await page.getByLabel("Password", { exact: true }).fill("password123");
await page.getByRole("button", { name: /^log in$/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

await api(`/channels/${channel.id}/messages`, {
  method: "POST",
  token: aliceToken,
  body: { content: "the answer is ||forty two||" },
});

await page.goto(`${BASE}/channels/${serverA.id}/${channel.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const spoiler = page.locator("span.spoiler").last();
if ((await spoiler.count()) > 0) {
  ok("spoiler markup rendered");
  // The point of a spoiler is that the text is not readable, which is a *computed style* question —
  // the text is present in the DOM either way, so asserting on textContent would pass on a
  // completely broken spoiler.
  const hiddenColor = await spoiler.evaluate((el) => getComputedStyle(el).color);
  if (hiddenColor.includes("rgba(0, 0, 0, 0)") || hiddenColor === "transparent") ok("spoiler text is transparent before clicking");
  else bad("spoiler text is visible", hiddenColor);

  await spoiler.click();
  await page.waitForTimeout(300);
  const shownColor = await spoiler.evaluate((el) => getComputedStyle(el).color);
  if (!shownColor.includes("rgba(0, 0, 0, 0)")) ok("spoiler reveals on click");
  else bad("spoiler did not reveal", shownColor);
} else {
  bad("no spoiler span rendered");
}

// The composer's spoiler button, so the syntax is discoverable rather than folklore.
if ((await page.getByRole("button", { name: /spoiler/i }).count()) > 0) ok("the composer has a spoiler button");
else bad("no spoiler button in the composer");
if ((await page.getByRole("button", { name: /attach a poll/i }).count()) > 0) ok("the composer has a poll button");
else bad("no poll button in the composer");
if ((await page.getByRole("button", { name: /send a sticker/i }).count()) > 0) ok("the composer has a sticker button");
else bad("no sticker button in the composer");

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
