import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { generateSecret as otpGenerateSecret, generateURI, verifySync } from "otplib";
import { env } from "../config/env.js";

/**
 * TOTP second factor.
 *
 * ## Why the secret is encrypted and not hashed
 *
 * Every other credential in this codebase is hashed — passwords, refresh tokens, bot tokens, backup
 * codes below. A TOTP secret cannot be, because verification means recomputing the current code
 * from the original value; there is nothing to compare a hash against. So it is encrypted at rest
 * with AES-256-GCM instead.
 *
 * The honest consequence, worth stating rather than implying: a database dump alone does not yield
 * working second factors, but a dump **plus the application key** does. That is strictly better
 * than plaintext and strictly worse than a password hash, and it is the best available for this
 * mechanism.
 *
 * ## Where the key comes from
 *
 * `TOTP_ENCRYPTION_KEY` if set. Otherwise it is derived from `JWT_ACCESS_SECRET` via HKDF with a
 * fixed, distinct info string — so the same env var never produces the same bytes for two different
 * purposes, which is the whole point of a KDF over "just reuse the secret".
 *
 * **Rotating `JWT_ACCESS_SECRET` while relying on the fallback invalidates every enrolled second
 * factor**, locking those users out until they use a backup code. Set `TOTP_ENCRYPTION_KEY`
 * explicitly to decouple the two.
 */

const KEY_INFO = "lumina-totp-secret-encryption-v1";

function encryptionKey(): Buffer {
  const explicit = process.env.TOTP_ENCRYPTION_KEY;
  if (explicit && explicit.length >= 32) return Buffer.from(hkdfSync("sha256", explicit, "", KEY_INFO, 32));
  return Buffer.from(hkdfSync("sha256", env.JWT_ACCESS_SECRET, "", KEY_INFO, 32));
}

/** `v1.<iv>.<authTag>.<ciphertext>`, all base64url. Versioned so the format can change later
 * without having to guess how an existing row was written. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string): string | null {
  try {
    const [version, iv, tag, ciphertext] = stored.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key (JWT_ACCESS_SECRET rotated), or a tampered row. Either way this is not a working
    // second factor, and returning null lets the caller fall back to a backup code rather than
    // throwing a 500 into a login.
    return null;
  }
}

/**
 * One 30-second step either side.
 *
 * Phone clocks drift, and a code typed at the very end of its life would otherwise be rejected
 * after the user did nothing wrong. One step keeps the total acceptance window to 90 seconds, which
 * is the usual compromise between that and handing an attacker extra time.
 *
 * Note this is otplib v13's `epochTolerance`, not v12's `window` — the whole `authenticator`
 * singleton was removed in v13 and replaced by these functional calls.
 */
const EPOCH_TOLERANCE = 1;

export function generateSecret(): string {
  return otpGenerateSecret();
}

/** The `otpauth://` URI an authenticator app scans. Rendered to a QR code **client-side** — sending
 * the secret to an external QR service would hand the second factor to a third party. */
export function otpauthURI(params: { secret: string; accountName: string; issuer?: string }): string {
  return generateURI({
    strategy: "totp",
    issuer: params.issuer ?? "Lumina",
    label: params.accountName,
    secret: params.secret,
  });
}

/** Verifies a 6-digit code. Never throws — a mistyped code is an ordinary event, not an error, and
 * otplib signals malformed input by exception. */
export function verifyCode(params: { token: string; secret: string }): boolean {
  const token = params.token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return verifySync({
      token,
      secret: params.secret,
      strategy: "totp",
      epochTolerance: EPOCH_TOLERANCE,
    }).valid;
  } catch {
    return false;
  }
}

/**
 * Recovery codes, shown once at enrolment.
 *
 * Generated with `randomInt`, which draws from the same CSPRNG as `randomBytes` — `Math.random` is
 * not acceptable for something that bypasses the second factor entirely.
 *
 * Formatted in two groups of five digits because these get written on paper, and an unbroken
 * ten-character string is materially easier to transcribe wrongly.
 */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join("");
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  });
}

/** Normalises for comparison, so a code typed without its hyphen still matches. */
export function normaliseBackupCode(code: string): string {
  return code.replace(/[^0-9]/g, "");
}
