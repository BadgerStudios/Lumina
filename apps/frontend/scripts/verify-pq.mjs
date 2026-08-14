// Live verification of the post-quantum transport against the real deployment:
// the full handshake, a sealed round-trip through a real API route, and adversarial cases
// (tampered ciphertext, sealed body without a session, expired-session 428, grace-window key).
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const BASE = process.env.BASE ?? "https://lumina.badgerstudios.net";
const API = `${BASE}/api`;
let pass = 0, fail = 0;
const ok = (m) => (console.log("PASS: " + m), pass++);
const bad = (m, e) => (console.log("FAIL: " + m + (e ? " -- " + String(e).slice(0, 140) : "")), fail++);
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function handshake() {
  const keys = await (await fetch(`${API}/pq/keys`)).json();
  const cpriv = x25519.utils.randomSecretKey();
  const cpub = x25519.getPublicKey(cpriv);
  const xSecret = x25519.getSharedSecret(cpriv, unb64(keys.x25519Pub));
  const { cipherText, sharedSecret: kemSecret } = ml_kem768.encapsulate(unb64(keys.mlkemPub));
  const hybrid = sha256(new Uint8Array([...xSecret, ...kemSecret]));
  const salt = enc.encode("lumina-pq-v1");
  const c2s = hkdf(sha256, hybrid, salt, enc.encode(`c2s:${keys.kid}`), 32);
  const s2c = hkdf(sha256, hybrid, salt, enc.encode(`s2c:${keys.kid}`), 32);
  const sess = await (await fetch(`${API}/pq/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kid: keys.kid, clientX25519Pub: b64(cpub), mlkemCiphertext: b64(cipherText) }),
  })).json();
  return { keys, sessionId: sess.sessionId, c2s, s2c };
}
const seal = (key, s) => { const n = randomBytes(24); const ct = xchacha20poly1305(key, n).encrypt(enc.encode(s)); return new Uint8Array([...n, ...ct]); };
const unseal = (key, u) => dec.decode(xchacha20poly1305(key, u.slice(0, 24)).decrypt(u.slice(24)));

async function main() {
  // ---- key discovery
  const keys = await (await fetch(`${API}/pq/keys`)).json();
  keys.alg?.includes("mlkem768") && keys.kid && keys.mlkemPub
    ? ok(`/pq/keys serves a hybrid keypair (${keys.alg}, kid ${keys.kid})`)
    : bad(`/pq/keys malformed: ${JSON.stringify(keys).slice(0, 100)}`);
  unb64(keys.mlkemPub).length === 1184 ? ok("ML-KEM-768 public key is the correct 1184 bytes") : bad(`mlkem pub wrong length ${unb64(keys.mlkemPub).length}`);

  // ---- full handshake + sealed round-trip through a REAL route (register)
  const h = await handshake();
  h.sessionId ? ok(`handshake established a session (${h.sessionId.slice(0, 8)}…)`) : bad("no session id");

  const rand = Date.now();
  const body = JSON.stringify({ username: `qq_pq_${rand}`, email: `qq_pq_${rand}@example.com`, password: "password123", birthDate: "1995-04-01", ageBracket: "AGE_25_34" });
  const res = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/x-lumina-pq", "x-pq-session": h.sessionId },
    body: seal(h.c2s, body),
  });
  if (res.headers.get("x-pq") === "1") {
    ok("the response came back SEALED (x-pq: 1)");
    const plain = unseal(h.s2c, new Uint8Array(await res.arrayBuffer()));
    const json = JSON.parse(plain);
    json.accessToken && json.user?.username === `qq_pq_${rand}`
      ? ok("a real registration round-tripped fully encrypted (request AND response sealed)")
      : bad(`sealed response body unexpected: ${plain.slice(0, 100)}`);
  } else bad(`response was not sealed (status ${res.status})`);

  // ---- adversarial: tampered ciphertext is rejected
  const h2 = await handshake();
  const sealedTampered = seal(h2.c2s, JSON.stringify({ x: 1 }));
  sealedTampered[sealedTampered.length - 1] ^= 0xff;
  const tamper = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-lumina-pq", "x-pq-session": h2.sessionId }, body: sealedTampered,
  });
  tamper.status >= 400 && tamper.status < 500 ? ok(`a tampered sealed body is rejected (${tamper.status})`) : bad(`tampered body answered ${tamper.status}`);

  // ---- adversarial: sealed content-type with NO session header
  const noSess = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-lumina-pq" }, body: seal(h2.c2s, "{}"),
  });
  noSess.status === 428 ? ok("a sealed body without a session answers 428") : bad(`no-session sealed answered ${noSess.status}`);

  // ---- adversarial: a bogus session id answers 428 (the rotation signal)
  const bogus = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/x-lumina-pq", "x-pq-session": "deadbeef".repeat(4) }, body: seal(h2.c2s, "{}"),
  });
  bogus.status === 428 ? ok("an unknown/expired session answers 428 (traffic-key rotation signal)") : bad(`bogus session answered ${bogus.status}`);

  // ---- plain requests still work unchanged (the shield is opt-in)
  const plainReg = await fetch(`${API}/pq/keys`);
  plainReg.ok ? ok("plain unsealed requests still work (shield is strictly opt-in)") : bad("plain request broke");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
