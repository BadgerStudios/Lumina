// Encrypts a backup file before it leaves the machine.
//
// ## Why this is worth doing even though the bucket is private
//
// The bucket being private is one control, enforced by a service outside this codebase, and it has
// already been wrong once — the backups bucket was briefly public earlier in this project's life,
// which is why scripts/backup-offsite.mjs now writes a canary and refuses to upload if any host
// serves it. Encryption is the control that survives that mistake happening again: a public
// dump of ciphertext is an embarrassment, a public dump of the database is every user's email
// address, date of birth and password hash.
//
// ## The key
//
// `BACKUP_ENCRYPTION_KEY` in .env — a passphrase, from which the actual key is derived with
// scrypt and a per-file random salt. Deriving rather than using the passphrase directly means a
// short or low-entropy passphrase still costs an attacker real work per guess.
//
// **If the key is lost, the backups are unreadable.** That is the point, and it is also the risk:
// a backup you cannot decrypt is not a backup. The key must be stored somewhere OTHER than this
// machine, because the whole scenario these backups exist for is this machine being gone.
//
// Format: MAGIC | salt(16) | iv(12) | authTag(16) | ciphertext — AES-256-GCM, so tampering is
// detected on decrypt rather than producing garbage that looks like a corrupt archive.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";

const MAGIC = Buffer.from("LUMENC1\0", "utf8"); // 8 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(passphrase, salt) {
  // N=2^15 keeps derivation around a tenth of a second — negligible once per backup, and a real
  // per-guess cost for anyone brute-forcing the passphrase.
  return scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptFile(inputPath, outputPath, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const plaintext = fs.readFileSync(inputPath);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  fs.writeFileSync(outputPath, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]));
  return { bytes: fs.statSync(outputPath).size };
}

export function decryptFile(inputPath, outputPath, passphrase) {
  const blob = fs.readFileSync(inputPath);
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a Lumina encrypted backup (bad magic)");
  }

  let offset = MAGIC.length;
  const salt = blob.subarray(offset, (offset += SALT_LEN));
  const iv = blob.subarray(offset, (offset += IV_LEN));
  const tag = blob.subarray(offset, (offset += TAG_LEN));
  const ciphertext = blob.subarray(offset);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  // Throws on a wrong passphrase or a tampered file rather than emitting plausible garbage — GCM's
  // whole point, and what makes a restore either work or fail loudly.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  fs.writeFileSync(outputPath, plaintext);
  return { bytes: plaintext.length };
}

export function encryptionConfigured() {
  return Boolean(process.env.BACKUP_ENCRYPTION_KEY && process.env.BACKUP_ENCRYPTION_KEY.length >= 12);
}

// CLI: encrypt/decrypt a single file, so a restore does not require writing code at the worst
// possible moment.
if (process.argv[1]?.endsWith("encrypt-backup.mjs")) {
  const [, , mode, input, output] = process.argv;
  const passphrase = process.env.BACKUP_ENCRYPTION_KEY;

  if (!mode || !input || !output) {
    console.error("usage: BACKUP_ENCRYPTION_KEY=... node scripts/encrypt-backup.mjs <encrypt|decrypt> <in> <out>");
    process.exit(2);
  }
  if (!passphrase) {
    console.error("BACKUP_ENCRYPTION_KEY is not set");
    process.exit(2);
  }

  try {
    const result = mode === "encrypt"
      ? encryptFile(input, output, passphrase)
      : decryptFile(input, output, passphrase);
    console.log(`${mode}ed -> ${output} (${(result.bytes / 1024 / 1024).toFixed(1)}MB)`);
  } catch (e) {
    console.error(`${mode} failed: ${e.message}`);
    process.exit(1);
  }
}
