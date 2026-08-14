import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";

/**
 * Client half of the post-quantum transport (see backend modules/pq/service.ts for the design
 * and its honest scope). Hybrid X25519 + ML-KEM-768 handshake once per session; every JSON
 * request/response body is then sealed with XChaCha20-Poly1305 under direction-separated keys.
 *
 * STRICTLY BEST-EFFORT BY DESIGN: if the handshake fails (old backend, network hiccup, key
 * mismatch) the app falls back to plain JSON over TLS and retries the shield later — the
 * encryption layer must never be the reason someone can't log in.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

interface PqSession {
  sessionId: string;
  c2s: Uint8Array;
  s2c: Uint8Array;
  expiresAt: number;
}

let session: PqSession | null = null;
let handshakeInFlight: Promise<PqSession | null> | null = null;
let disabledUntil = 0; // backoff after a failed handshake

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function handshake(apiBase: string): Promise<PqSession | null> {
  try {
    const keysRes = await fetch(`${apiBase}/pq/keys`);
    if (!keysRes.ok) return null;
    const keys = (await keysRes.json()) as { kid: string; x25519Pub: string; mlkemPub: string };

    const clientPriv = x25519.utils.randomSecretKey();
    const clientPub = x25519.getPublicKey(clientPriv);
    const xSecret = x25519.getSharedSecret(clientPriv, unb64(keys.x25519Pub));
    const { cipherText, sharedSecret: kemSecret } = ml_kem768.encapsulate(unb64(keys.mlkemPub));

    const hybrid = sha256(new Uint8Array([...xSecret, ...kemSecret]));
    const salt = enc.encode("lumina-pq-v1");
    const c2s = hkdf(sha256, hybrid, salt, enc.encode(`c2s:${keys.kid}`), 32);
    const s2c = hkdf(sha256, hybrid, salt, enc.encode(`s2c:${keys.kid}`), 32);

    const sessRes = await fetch(`${apiBase}/pq/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kid: keys.kid, clientX25519Pub: b64(clientPub), mlkemCiphertext: b64(cipherText) }),
    });
    if (!sessRes.ok) return null;
    const { sessionId, expiresIn } = (await sessRes.json()) as { sessionId: string; expiresIn: number };
    // Refresh two minutes early so a request never straddles the expiry.
    return { sessionId, c2s, s2c, expiresAt: Date.now() + (expiresIn - 120) * 1000 };
  } catch {
    return null;
  }
}

export async function pqSession(apiBase: string): Promise<PqSession | null> {
  if (session && Date.now() < session.expiresAt) return session;
  if (Date.now() < disabledUntil) return null;
  if (!handshakeInFlight) {
    handshakeInFlight = handshake(apiBase).finally(() => {
      handshakeInFlight = null;
    });
  }
  session = await handshakeInFlight;
  if (!session) disabledUntil = Date.now() + 60_000; // don't hammer a struggling backend
  return session;
}

/** Server told us the session is gone (428) — drop it so the next call re-handshakes. */
export function pqInvalidate(): void {
  session = null;
}

export function pqSeal(s: PqSession, plaintext: string): Uint8Array {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(s.c2s, nonce).encrypt(enc.encode(plaintext));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return out;
}

export function pqUnseal(s: PqSession, sealed: Uint8Array): string {
  const nonce = sealed.slice(0, 24);
  const ct = sealed.slice(24);
  return dec.decode(xchacha20poly1305(s.s2c, nonce).decrypt(ct));
}
