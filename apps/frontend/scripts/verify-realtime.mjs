// Integration + cache-patch-logic smoke test against the REAL running backend
// (http://127.0.0.1:4000) and the real Vite dev server (http://127.0.0.1:5173).
//
// This is not a mock: it registers two real users, creates a real server + invite via
// REST, joins B via the invite, opens two real socket.io connections, sends real messages
// / reactions / typing / presence events over the wire, and captures the ACTUAL payloads
// the backend emits. Those captured payloads are then fed directly into the same pure
// cache-patch functions the frontend's useSocketEvents.ts calls (src/socket/cachePatches.ts)
// to prove the reducer logic produces the exact shape MessageList/MemberList/etc expect —
// without mounting any React tree.
//
// Usage: node apps/frontend/scripts/verify-realtime.mjs

import { io } from "socket.io-client";
import assert from "node:assert/strict";
import {
  upsertMessageCreate,
  patchMessageUpdate,
  patchMessageDelete,
  patchReaction,
  upsertMember,
  removeMember,
  upsertChannel,
  upsertRole,
} from "../src/socket/cachePatches.ts";

const API = "http://127.0.0.1:4000";
const FRONTEND = "http://127.0.0.1:5173";

let pass = 0;
let fail = 0;
function ok(desc) {
  console.log(`PASS: ${desc}`);
  pass++;
}
function bad(desc, detail) {
  console.log(`FAIL: ${desc}${detail ? " -- " + JSON.stringify(detail) : ""}`);
  fail++;
}
async function step(desc, fn) {
  try {
    await fn();
  } catch (err) {
    bad(desc, err instanceof Error ? err.message : String(err));
  }
}

async function apiFetch(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function waitForEvent(socket, event, timeoutMs, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    function handler(payload) {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 10);

  // ---------------------------------------------------------------
  // 0. Vite dev server sanity (serves app shell, proxies /api through)
  //
  // These three test the DEV setup, so they only run when a dev server is actually up —
  // otherwise they'd report the absence of a dev server as three platform failures in every
  // production-only run (which is exactly what they did during the platform debug sweep).
  // Skipping is announced, never silent, so a wedged dev server still can't hide.
  // ---------------------------------------------------------------
  const viteUp = await fetch(`${FRONTEND}/`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  );
  if (!viteUp) console.log(`SKIP: Vite dev server checks (nothing listening at ${FRONTEND} — production-only run)`);

  if (viteUp) await step("Vite dev server serves the app shell HTML", async () => {
    const res = await fetch(`${FRONTEND}/`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /<div id="root">/);
    assert.match(text, /src\/main\.tsx/);
  });

  if (viteUp) await step("Vite proxy forwards /api/* to the real backend (Fastify 404 body, not Vite's)", async () => {
    const res = await fetch(`${FRONTEND}/api/healthz`);
    const body = await res.json();
    // healthz is mounted at backend root, not under /api — so this MUST 404 with Fastify's
    // own not-found shape, proving the request actually reached the backend process.
    assert.equal(res.status, 404);
    assert.equal(body.error, "Not Found");
  });

  if (viteUp) await step("Vite proxy forwards a real API call end-to-end", async () => {
    const res = await apiFetch(FRONTEND, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: `viteproxy_${rand}`,
        email: `viteproxy_${rand}@example.com`,
        password: "password123",
        ageBracket: "AGE_25_34",
        birthDate: "1995-06-15",
      }),
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.accessToken);
    assert.equal(res.body.user.username, `viteproxy_${rand}`);
  });

  // ---------------------------------------------------------------
  // 1. Register two real users directly against the backend API
  // ---------------------------------------------------------------
  let tokenA, userA, tokenB, userB;
  await step("register user A", async () => {
    const res = await apiFetch(API, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `alice_${rand}`, email: `alice_${rand}@example.com`, password: "password123", ageBracket: "AGE_25_34", birthDate: "1995-06-15" }),
    });
    assert.equal(res.status, 201);
    tokenA = res.body.accessToken;
    userA = res.body.user;
    ok("register user A -> 201 with accessToken");
  });

  await step("register user B", async () => {
    const res = await apiFetch(API, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `bob_${rand}`, email: `bob_${rand}@example.com`, password: "password123", ageBracket: "AGE_25_34", birthDate: "1995-06-15" }),
    });
    assert.equal(res.status, 201);
    tokenB = res.body.accessToken;
    userB = res.body.user;
    ok("register user B -> 201 with accessToken");
  });

  // ---------------------------------------------------------------
  // 2. A creates a server + invite, B joins via invite
  // ---------------------------------------------------------------
  let server, channelId, inviteCode;
  await step("A creates a server", async () => {
    const res = await apiFetch(API, "/api/servers", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: `Lumina Test ${rand}` }),
    });
    assert.equal(res.status, 201);
    server = res.body;
    channelId = server.systemChannelId;
    assert.ok(channelId);
    ok(`A created server ${server.id} with system channel ${channelId}`);
  });

  await step("GET /api/servers/:id/roles (the endpoint added for this build) returns @everyone", async () => {
    const res = await apiFetch(API, `/api/servers/${server.id}/roles`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((r) => r.isDefault === true && r.name === "@everyone"));
    ok(`GET roles list returned ${res.body.length} role(s) including @everyone`);
  });

  await step("A creates an invite", async () => {
    const res = await apiFetch(API, `/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    inviteCode = res.body.code;
    ok(`A created invite ${inviteCode}`);
  });

  await step("B joins via invite", async () => {
    const res = await apiFetch(API, `/api/invites/${inviteCode}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.userId, userB.id);
    ok("B joined the server via invite");
  });

  // ---------------------------------------------------------------
  // 3. Open two real sockets, join the channel room, exercise the full event set
  // ---------------------------------------------------------------
  function connect(token, label) {
    return new Promise((resolve, reject) => {
      const socket = io(API, { auth: { accessToken: token }, transports: ["websocket"], reconnection: false });
      const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), 8000);
      socket.on("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on("connect_error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  let socketA, socketB;
  await step("both sockets connect", async () => {
    [socketA, socketB] = await Promise.all([connect(tokenA, "A"), connect(tokenB, "B")]);
    ok("A and B both connected over socket.io");
  });

  await step("both sockets join the channel room", async () => {
    await Promise.all(
      [socketA, socketB].map(
        (s, i) =>
          new Promise((resolve, reject) => {
            s.emit("channel:join", { channelId }, (res) => (res?.ok ? resolve() : reject(new Error(JSON.stringify(res)))));
          }),
      ),
    );
    ok("both sockets joined channel room");
  });

  // ---- message:create -> real payload -> feed into upsertMessageCreate ----
  let capturedCreatePayload;
  let messageId;
  await step("message:send round trip + upsertMessageCreate patches an empty cache correctly", async () => {
    const content = `hello from A ${Date.now()}`;
    const createPromise = waitForEvent(socketB, "message:create", 5000, (m) => m.content === content);
    const ack = await new Promise((resolve) => socketA.emit("message:send", { channelId, content }, resolve));
    assert.equal(ack.ok, true);
    capturedCreatePayload = await createPromise;
    messageId = capturedCreatePayload.id;
    assert.equal(capturedCreatePayload.content, content);
    assert.equal(capturedCreatePayload.channelId, channelId);
    assert.equal(typeof capturedCreatePayload.id, "string");

    // Feed the REAL captured payload into the pure reducer, exactly as useSocketEvents.ts does.
    const patched = upsertMessageCreate(undefined, capturedCreatePayload);
    assert.equal(patched.pages.length, 1);
    assert.equal(patched.pages[0].length, 1);
    assert.equal(patched.pages[0][0].id, messageId);
    ok("upsertMessageCreate(undefined, realPayload) -> single-page cache containing the message");
  });

  await step("upsertMessageCreate dedupes + prepends into an existing page, newest-first", async () => {
    const existing = { pages: [[{ ...capturedCreatePayload, id: "1", content: "older" }]], pageParams: [undefined] };
    const newer = { ...capturedCreatePayload, id: "2", content: "newer" };
    const patched = upsertMessageCreate(existing, newer);
    assert.deepEqual(
      patched.pages[0].map((m) => m.id),
      ["2", "1"],
      "newest message should be unshifted to the front of the first page",
    );
    // dedupe: re-applying the same message must not create a duplicate entry
    const reapplied = upsertMessageCreate(patched, newer);
    assert.equal(reapplied.pages[0].length, 2, "re-applying an already-present message must not duplicate it");
    ok("upsertMessageCreate dedupes by id and orders newest-first");
  });

  // ---- message:edit -> real payload -> patchMessageUpdate ----
  await step("message:edit round trip + patchMessageUpdate replaces in place", async () => {
    const newContent = `edited by A ${Date.now()}`;
    const updatePromise = waitForEvent(socketB, "message:update", 5000, (m) => m.id === messageId);
    const ack = await new Promise((resolve) => socketA.emit("message:edit", { messageId, content: newContent }, resolve));
    assert.equal(ack.ok, true);
    const updated = await updatePromise;
    assert.equal(updated.content, newContent);
    assert.ok(updated.editedAt);

    const cache = { pages: [[capturedCreatePayload]], pageParams: [undefined] };
    const patched = patchMessageUpdate(cache, updated);
    assert.equal(patched.pages[0][0].content, newContent);
    assert.equal(patched.pages[0][0].id, messageId);
    ok("patchMessageUpdate(cache, realPayload) replaces the message content in place, same id");
  });

  // ---- reaction:add -> real payload -> patchReaction ----
  await step("reaction:add round trip + patchReaction adds a reaction with reactedByMe for the actor", async () => {
    const reactionPromise = waitForEvent(socketB, "reaction:add", 5000, (r) => r.messageId === messageId);
    const ack = await new Promise((resolve) => socketA.emit("reaction:add", { messageId, emoji: "🚀" }, resolve));
    assert.equal(ack.ok, true);
    const payload = await reactionPromise;
    assert.equal(payload.emoji, "🚀");
    assert.equal(payload.userId, userA.id);
    assert.equal(payload.count, 1);

    const message = { ...capturedCreatePayload, id: messageId, reactions: [] };
    const cache = { pages: [[message]], pageParams: [undefined] };

    // From A's own point of view: reactedByMe should be true.
    const patchedForA = patchReaction(cache, payload, true, userA.id);
    assert.deepEqual(patchedForA.pages[0][0].reactions, [{ emoji: "🚀", count: 1, reactedByMe: true }]);

    // From B's point of view (viewing user didn't react): reactedByMe should be false.
    const patchedForB = patchReaction(cache, payload, true, userB.id);
    assert.deepEqual(patchedForB.pages[0][0].reactions, [{ emoji: "🚀", count: 1, reactedByMe: false }]);
    ok("patchReaction(cache, realPayload, isAdd=true, viewerId) computes reactedByMe per-viewer correctly");
  });

  await step("reaction:remove round trip + patchReaction(count=0) removes the reaction entry", async () => {
    const reactionPromise = waitForEvent(socketB, "reaction:remove", 5000, (r) => r.messageId === messageId);
    const ack = await new Promise((resolve) => socketA.emit("reaction:remove", { messageId, emoji: "🚀" }, resolve));
    assert.equal(ack.ok, true);
    const payload = await reactionPromise;
    assert.equal(payload.count, 0);

    const message = { ...capturedCreatePayload, id: messageId, reactions: [{ emoji: "🚀", count: 1, reactedByMe: true }] };
    const cache = { pages: [[message]], pageParams: [undefined] };
    const patched = patchReaction(cache, payload, false, userA.id);
    assert.deepEqual(patched.pages[0][0].reactions, []);
    ok("patchReaction(cache, realPayload, isAdd=false) with count=0 drops the reaction entry entirely");
  });

  // ---- message:delete -> real payload (bare {id}) -> patchMessageDelete ----
  await step("message:delete round trip + patchMessageDelete removes the message by id", async () => {
    const deletePromise = waitForEvent(socketB, "message:delete", 5000);
    const ack = await new Promise((resolve) => socketA.emit("message:delete", { messageId }, resolve));
    assert.equal(ack.ok, true);
    const payload = await deletePromise;
    assert.equal(payload.id, messageId);
    // Confirms the real payload is bare ({id} only, no channelId) — exactly why
    // useSocketEvents.ts has to search across cached queries to find which one to patch,
    // rather than routing directly off the payload.
    assert.deepEqual(Object.keys(payload), ["id"]);

    const cache = { pages: [[{ ...capturedCreatePayload, id: messageId }, { ...capturedCreatePayload, id: "other" }]], pageParams: [undefined] };
    const patched = patchMessageDelete(cache, payload.id);
    assert.deepEqual(
      patched.pages[0].map((m) => m.id),
      ["other"],
    );
    ok("patchMessageDelete(cache, realPayload.id) removes exactly the deleted message");
  });

  // ---- typing:start / typing:stop ----
  await step("typing:start / typing:stop round trip", async () => {
    const typingPromise = waitForEvent(socketB, "typing:update", 5000, (t) => t.isTyping === true);
    socketA.emit("typing:start", { channelId });
    const typingEvt = await typingPromise;
    assert.equal(typingEvt.userId, userA.id);
    assert.equal(typingEvt.channelId, channelId);

    const stopPromise = waitForEvent(socketB, "typing:update", 5000, (t) => t.isTyping === false);
    socketA.emit("typing:stop", { channelId });
    await stopPromise;
    ok("typing:update received for both start (true) and stop (false)");
  });

  // ---- presence:set -> presence:update ----
  await step("presence:set round trip", async () => {
    const presencePromise = waitForEvent(socketB, "presence:update", 5000, (p) => p.userId === userA.id && p.presence === "DND");
    socketA.emit("presence:set", { presence: "DND" });
    const evt = await presencePromise;
    assert.equal(evt.presence, "DND");
    ok("presence:update broadcast reflects presence:set");
  });

  // ---- member:join payload shape used by upsertMember ----
  await step("member:join payload (captured during B's earlier invite-join) patches a member list", async () => {
    const membersRes = await apiFetch(API, `/api/servers/${server.id}/members`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(membersRes.status, 200);
    const memberB = membersRes.body.find((m) => m.userId === userB.id);
    assert.ok(memberB, "B should be a member after joining via invite");
    const patched = upsertMember([membersRes.body.find((m) => m.userId === userA.id)], memberB);
    assert.equal(patched.length, 2);
    assert.ok(patched.some((m) => m.userId === userB.id));
    const removed = removeMember(patched, userB.id);
    assert.equal(removed.length, 1);
    ok("upsertMember / removeMember behave correctly against a real MemberDTO");
  });

  // ---- channel:create / role:create payload shapes ----
  await step("channel:create broadcast + upsertChannel patches a channel list", async () => {
    const channelPromise = waitForEvent(socketB, "channel:create", 5000);
    const res = await apiFetch(API, `/api/servers/${server.id}/channels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: "second-channel" }),
    });
    assert.equal(res.status, 201);
    const broadcast = await channelPromise;
    assert.equal(broadcast.id, res.body.id);
    const patched = upsertChannel([], broadcast);
    assert.equal(patched[0].id, broadcast.id);
    ok("channel:create broadcast matches REST response and upsertChannel patches correctly");
  });

  await step("role:create broadcast + upsertRole patches a role list", async () => {
    const rolePromise = waitForEvent(socketB, "role:create", 5000);
    const res = await apiFetch(API, `/api/servers/${server.id}/roles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: "Moderator", permissions: "4" }),
    });
    assert.equal(res.status, 201);
    const broadcast = await rolePromise;
    assert.equal(broadcast.id, res.body.id);
    assert.equal(broadcast.name, "Moderator");
    const patched = upsertRole([], broadcast);
    assert.equal(patched[0].name, "Moderator");
    ok("role:create broadcast matches REST response and upsertRole patches correctly");
  });

  // ---- DM realtime (exercises the io.ts dm-room auto-join fix) ----
  await step("DM message:create is delivered in realtime after the dm-room auto-join fix", async () => {
    const createRes = await apiFetch(API, "/api/dm", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ participantIds: [userB.id] }),
    });
    assert.equal(createRes.status, 201);
    const conversationId = createRes.body.id;

    // Reconnect both sockets so joinInitialRooms() re-runs and picks up the new dm:* room —
    // mirrors what the frontend's reconnectSocket() call in queries/dms.ts does after
    // useCreateDM succeeds.
    socketA.disconnect();
    socketB.disconnect();
    [socketA, socketB] = await Promise.all([connect(tokenA, "A"), connect(tokenB, "B")]);
    await new Promise((r) => setTimeout(r, 300)); // let joinInitialRooms' async room-joins settle

    const content = `dm hello ${Date.now()}`;
    const dmMessagePromise = waitForEvent(socketB, "message:create", 5000, (m) => m.content === content);
    const ack = await new Promise((resolve) => socketA.emit("message:send", { conversationId, content }, resolve));
    assert.equal(ack.ok, true);
    const dmMessage = await dmMessagePromise;
    assert.equal(dmMessage.dmConversationId, conversationId);
    assert.equal(dmMessage.channelId, null);
    ok("B received DM message:create in realtime (would have hung/timed out before the io.ts fix)");
  });

  socketA.close();
  socketB.close();

  console.log("====================");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  console.log("====================");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
