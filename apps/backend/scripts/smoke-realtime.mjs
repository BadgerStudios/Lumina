// Realtime smoke test: two socket.io-client connections (A, B) join the same
// channel; A sends a message, we confirm B receives message:create; then we
// round-trip typing:start/typing:update and reaction:add/reaction:add.
//
// Usage:
//   WS_URL=http://localhost:4000 TOKEN_A=... TOKEN_B=... CHANNEL_ID=... node scripts/smoke-realtime.mjs

import { io } from "socket.io-client";

const WS_URL = process.env.WS_URL || "http://localhost:4000";
const TOKEN_A = process.env.TOKEN_A;
const TOKEN_B = process.env.TOKEN_B;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN_A || !TOKEN_B || !CHANNEL_ID) {
  console.error("Missing TOKEN_A / TOKEN_B / CHANNEL_ID env vars");
  process.exit(2);
}

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

function connect(token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(WS_URL, {
      auth: { accessToken: token },
      transports: ["websocket"],
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), 8000);
    socket.on("connect", () => {
      clearTimeout(timer);
      ok(`${label} connected (socket id ${socket.id})`);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function joinChannel(socket, channelId, label) {
  return new Promise((resolve, reject) => {
    socket.emit("channel:join", { channelId }, (res) => {
      if (res?.ok) {
        ok(`${label} joined channel ${channelId}`);
        resolve();
      } else {
        reject(new Error(`${label} failed to join channel: ${res?.error}`));
      }
    });
  });
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
  const socketA = await connect(TOKEN_A, "A");
  const socketB = await connect(TOKEN_B, "B");

  await joinChannel(socketA, CHANNEL_ID, "A");
  await joinChannel(socketB, CHANNEL_ID, "B");

  // --- message:send -> message:create round trip ---
  const content = `hello from A ${Date.now()}`;
  const messageCreatePromise = waitForEvent(socketB, "message:create", 5000, (m) => m.content === content);

  const sendAck = await new Promise((resolve) => {
    socketA.emit("message:send", { channelId: CHANNEL_ID, content }, (res) => resolve(res));
  });
  if (sendAck?.ok) ok("A message:send ack ok");
  else bad("A message:send ack", sendAck);

  try {
    const received = await messageCreatePromise;
    if (received.content === content) ok("B received message:create with matching content");
    else bad("B message:create content mismatch", received);
    var messageId = received.id;
  } catch (err) {
    bad("B did not receive message:create in time", err.message);
  }

  // --- typing:start -> typing:update round trip ---
  const typingPromise = waitForEvent(socketB, "typing:update", 5000, (t) => t.userId && t.isTyping === true);
  socketA.emit("typing:start", { channelId: CHANNEL_ID });
  try {
    const typingEvt = await typingPromise;
    ok(`B received typing:update isTyping=true from ${typingEvt.userId}`);
  } catch (err) {
    bad("B did not receive typing:update(start)", err.message);
  }

  const typingStopPromise = waitForEvent(socketB, "typing:update", 5000, (t) => t.isTyping === false);
  socketA.emit("typing:stop", { channelId: CHANNEL_ID });
  try {
    await typingStopPromise;
    ok("B received typing:update isTyping=false");
  } catch (err) {
    bad("B did not receive typing:update(stop)", err.message);
  }

  // --- reaction:add round trip ---
  if (messageId) {
    const reactionPromise = waitForEvent(socketB, "reaction:add", 5000, (r) => r.messageId === messageId);
    const reactAck = await new Promise((resolve) => {
      socketA.emit("reaction:add", { messageId, emoji: "👍" }, (res) => resolve(res));
    });
    if (reactAck?.ok) ok("A reaction:add ack ok");
    else bad("A reaction:add ack", reactAck);

    try {
      const reactionEvt = await reactionPromise;
      if (reactionEvt.emoji === "👍" && reactionEvt.count >= 1) ok("B received reaction:add broadcast");
      else bad("B reaction:add payload unexpected", reactionEvt);
    } catch (err) {
      bad("B did not receive reaction:add", err.message);
    }
  } else {
    bad("skipped reaction:add test", "no messageId from earlier step");
  }

  socketA.close();
  socketB.close();

  console.log("====================");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  console.log("====================");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error in smoke-realtime:", err);
  process.exit(1);
});
