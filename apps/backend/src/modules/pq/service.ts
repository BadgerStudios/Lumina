import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman, KeyObject } from "node:crypto";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { env } from "../../config/env.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Post-quantum encrypted transport ("PQ shield").
 *
 * WHAT THIS IS: a hybrid X25519 + ML-KEM-768 (NIST FIPS-203) key agreement, feeding
 * XChaCha20-Poly1305 sealed request/response bodies — an application-layer envelope INSIDE TLS.
 * Its point is "harvest now, decrypt later" resistance: traffic recorded today, including at any
 * TLS-terminating middlebox, stays confidential against a future quantum adversary, because the
 * hybrid secret is safe unless BOTH X25519 and ML-KEM fall.
 *
 * WHAT THIS IS NOT: homemade cryptography. Every primitive is standardized and comes from
 * audited implementations (node:crypto for X25519/HKDF/AES, noble for ML-KEM/XChaCha20). This
 * module only composes them, in the boring, conventional order.
 *
 * ROTATION, two layers:
 *  - KEM keypairs rotate every ROTATION_MS (worker sweep). The previous key stays valid for
 *    GRACE_MS so in-flight handshakes never race a rotation, then its private half is deleted.
 *  - Traffic keys rotate with the session: Redis TTL SESSION_TTL_S caps any symmetric key's
 *    lifetime, forcing a fresh handshake (and thus the newest KEM key) at least hourly.
 */

export const ROTATION_MS = 6 * 60 * 60 * 1000;
const GRACE_MS = 60 * 60 * 1000;
export const SESSION_TTL_S = 60 * 60;

// ---------------------------------------------------------------- at-rest key encryption

/** KEK derived from the server's refresh secret — DB exfiltration alone doesn't yield private
 * keys. AES-256-GCM, nonce prepended. */
const KEK = createHash("sha256").update(`lumina-pq-kek:${env.JWT_REFRESH_SECRET}`).digest();

function sealAtRest(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEK, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function openAtRest(sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ct = sealed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEK, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------------------------------------------------------------- keypair lifecycle

function rawX25519Public(key: KeyObject): Buffer {
  // SPKI DER for X25519 is a fixed 12-byte prefix + the 32 raw bytes.
  return key.export({ type: "spki", format: "der" }).subarray(-32);
}

export async function rotatePqKeys(force = false): Promise<{ rotated: boolean; kid?: string }> {
  const current = await prisma.pqKeypair.findFirst({ where: { retiredAt: null }, orderBy: { createdAt: "desc" } });
  if (current && !force && Date.now() - current.createdAt.getTime() < ROTATION_MS) {
    // Also prune long-retired keys while we're here.
    await prisma.pqKeypair.deleteMany({ where: { retiredAt: { lt: new Date(Date.now() - GRACE_MS) } } });
    return { rotated: false };
  }

  const x = generateKeyPairSync("x25519");
  const kem = ml_kem768.keygen();
  const kid = randomBytes(8).toString("hex");

  await prisma.$transaction(async (tx) => {
    if (current) await tx.pqKeypair.update({ where: { kid: current.kid }, data: { retiredAt: new Date() } });
    await tx.pqKeypair.create({
      data: {
        kid,
        x25519Pub: new Uint8Array(rawX25519Public(x.publicKey)),
        x25519Priv: new Uint8Array(sealAtRest(x.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer)),
        mlkemPub: new Uint8Array(kem.publicKey),
        mlkemPriv: new Uint8Array(sealAtRest(Buffer.from(kem.secretKey))),
      },
    });
    await tx.pqKeypair.deleteMany({ where: { retiredAt: { lt: new Date(Date.now() - GRACE_MS) } } });
  });
  return { rotated: true, kid };
}

export async function currentPqKeys(): Promise<{ kid: string; x25519Pub: string; mlkemPub: string; rotatedAt: string }> {
  let current = await prisma.pqKeypair.findFirst({ where: { retiredAt: null }, orderBy: { createdAt: "desc" } });
  if (!current) {
    await rotatePqKeys(true);
    current = await prisma.pqKeypair.findFirstOrThrow({ where: { retiredAt: null } });
  }
  return {
    kid: current.kid,
    x25519Pub: Buffer.from(current.x25519Pub).toString("base64"),
    mlkemPub: Buffer.from(current.mlkemPub).toString("base64"),
    rotatedAt: current.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------- handshake → session keys

const HKDF_SALT = Buffer.from("lumina-pq-v1");

function deriveDirectionKeys(hybridSecret: Buffer, kid: string): { c2s: Buffer; s2c: Buffer } {
  const c2s = Buffer.from(hkdfSync("sha256", hybridSecret, HKDF_SALT, `c2s:${kid}`, 32));
  const s2c = Buffer.from(hkdfSync("sha256", hybridSecret, HKDF_SALT, `s2c:${kid}`, 32));
  return { c2s, s2c };
}

/**
 * Client sends its ephemeral X25519 public key and an ML-KEM ciphertext against our published
 * key. Both shared secrets are combined; either surviving keeps the session confidential.
 * Accepts the retired key inside the grace window, so a handshake started just before a
 * rotation still completes.
 */
export async function establishSession(params: { kid: string; clientX25519Pub: string; mlkemCiphertext: string }): Promise<{ sessionId: string; expiresIn: number }> {
  const key = await prisma.pqKeypair.findUnique({ where: { kid: params.kid } });
  if (!key || (key.retiredAt && Date.now() - key.retiredAt.getTime() > GRACE_MS)) {
    throw new BadRequestError("Unknown or expired key id — refetch /pq/keys");
  }

  const clientPub = Buffer.from(params.clientX25519Pub, "base64");
  const kemCt = Buffer.from(params.mlkemCiphertext, "base64");
  if (clientPub.length !== 32 || kemCt.length !== 1088) throw new BadRequestError("Malformed handshake");

  const xPriv = createPrivateKey({ key: openAtRest(Buffer.from(key.x25519Priv)), type: "pkcs8", format: "der" });
  // Rebuild an SPKI KeyObject from the raw client key via the fixed X25519 DER prefix.
  const spki = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), clientPub]);
  const xSecret = diffieHellman({ privateKey: xPriv, publicKey: createPublicKey({ key: spki, type: "spki", format: "der" }) });
  const kemSecret = Buffer.from(ml_kem768.decapsulate(kemCt, openAtRest(Buffer.from(key.mlkemPriv))));

  const hybrid = createHash("sha256").update(Buffer.concat([xSecret, kemSecret])).digest();
  const { c2s, s2c } = deriveDirectionKeys(hybrid, params.kid);

  const sessionId = randomBytes(16).toString("hex");
  await redis.set(`pq:sess:${sessionId}`, JSON.stringify({ c2s: c2s.toString("hex"), s2c: s2c.toString("hex") }), "EX", SESSION_TTL_S);
  return { sessionId, expiresIn: SESSION_TTL_S };
}

export async function sessionKeys(sessionId: string): Promise<{ c2s: Buffer; s2c: Buffer } | null> {
  const raw = await redis.get(`pq:sess:${sessionId}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { c2s: string; s2c: string };
  return { c2s: Buffer.from(parsed.c2s, "hex"), s2c: Buffer.from(parsed.s2c, "hex") };
}

// ---------------------------------------------------------------- sealing

/** XChaCha20-Poly1305, 24-byte random nonce prepended. Same function both directions; the
 * DIRECTION is in the key, so a captured client→server blob can never be replayed back as a
 * server response. */
export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return Buffer.concat([nonce, Buffer.from(ct)]);
}

export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < 25) throw new BadRequestError("Sealed payload too short");
  const nonce = sealed.subarray(0, 24);
  const ct = sealed.subarray(24);
  try {
    return Buffer.from(xchacha20poly1305(key, nonce).decrypt(ct));
  } catch {
    throw new BadRequestError("Sealed payload failed authentication");
  }
}
