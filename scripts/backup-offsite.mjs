#!/usr/bin/env node
// Mirrors the newest local backup to R2, and prunes old remote copies.
//
// Called by scripts/backup.sh after the local dump has passed its integrity checks — never before.
// The ordering is the point: a backup that fails verification must not be uploaded, because the
// only thing worse than no offsite copy is an offsite copy you believe in and can't restore.
//
// ## Why this uploads rather than the whole directory syncing
//
// A sync would happily propagate a local deletion to the remote. That turns "someone wiped the
// backup directory" — accidentally or otherwise — into "the offsite copies are gone too", which
// defeats the entire reason for having them. This only ever adds, and prunes remotely on its own
// retention count.
//
// Usage: node scripts/backup-offsite.mjs [--prune-only]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, r2Configured, r2Client, putFile, listKeys, deleteKeys } from "./r2.mjs";
import { encryptFile, encryptionConfigured } from "./encrypt-backup.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
loadEnv(REPO);

const BACKUP_DIR = process.env.LUMINA_BACKUP_DIR ?? path.join(path.dirname(REPO), "lumina-backups");
const BUCKET = process.env.BACKUP_S3_BUCKET;
/** Kept deliberately longer offsite than locally: remote storage is cheap and the scenario offsite
 * copies exist for is one where the local disk is gone entirely. */
const KEEP_REMOTE = Number(process.env.LUMINA_BACKUP_KEEP_REMOTE ?? 30);

if (!r2Configured()) {
  console.log("[offsite] R2 not configured — local backup only");
  process.exit(0);
}

const newest = (prefix, ext) => {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
};

/**
 * Refuses to upload if the backups bucket answers to a public hostname.
 *
 * Added after the backups bucket was briefly made public by a dashboard misconfiguration: the
 * uploader happily wrote a full database dump into a world-readable bucket, because nothing in the
 * upload path had any opinion about who could read the destination. A backup system that will
 * cheerfully publish its own backups is worse than one that fails.
 *
 * Works by writing a canary object and trying to fetch it anonymously over each configured public
 * hostname. Testing an object we just created is the point — probing the bucket root proves
 * nothing, since a private bucket and a public-but-empty one both 404.
 */
async function assertBucketPrivate(client, bucket) {
  const hosts = (process.env.BACKUP_S3_PUBLIC_PROBE ?? "")
    .split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) return;

  const key = "_canary/public-check.txt";
  const tmp = path.join(os.tmpdir(), "lumina-canary.txt");
  fs.writeFileSync(tmp, "lumina public-exposure canary\n");
  await putFile(client, bucket, key, tmp, "text/plain");

  try {
    for (const host of hosts) {
      let status = 0;
      try {
        const res = await fetch(`${host.replace(/\/$/, "")}/${key}`, { redirect: "manual" });
        status = res.status;
      } catch {
        continue; // unreachable host is not evidence of exposure
      }
      if (status === 200) {
        throw new Error(
          `REFUSING TO UPLOAD: ${bucket} is publicly readable at ${host}. ` +
            `Disable public access on that bucket before backups go offsite.`,
        );
      }
    }
  } finally {
    await deleteKeys(client, bucket, [key]).catch(() => {});
    fs.rmSync(tmp, { force: true });
  }
}

async function main() {
  const client = r2Client();
  await assertBucketPrivate(client, BUCKET);
  const uploaded = [];

  for (const [prefix, ext] of [["db-", ".sql.gz"], ["uploads-", ".tar.gz"]]) {
    const file = newest(prefix, ext);
    if (!file) {
      console.log(`[offsite] no local ${prefix}* to upload`);
      continue;
    }
    const local = path.join(BACKUP_DIR, file);
    // Date-prefixed key so the bucket listing is chronological without needing metadata, and so a
    // human looking for "the backup from the 9th" can find it by eye.
    const key = `backups/${file}`;

    const existing = await listKeys(client, BUCKET, key);
    if (existing.length > 0 && existing[0].size === fs.statSync(local).size) {
      console.log(`[offsite] ${file} already uploaded`);
      continue;
    }

    // Encrypted before it leaves the machine, when a key is configured.
    //
    // The bucket being private is one control, enforced by a service outside this codebase — and it
    // has already been wrong once here. Encryption is what survives that happening again: a leaked
    // dump of ciphertext is an embarrassment, a leaked database is every user's email address, date
    // of birth and password hash.
    //
    // Unencrypted upload remains the fallback rather than a hard failure: an operator who has not
    // set a key still needs offsite backups, and refusing to upload would leave them with none.
    let uploadPath = local;
    let uploadKey = key;
    let contentType = "application/gzip";

    if (encryptionConfigured()) {
      uploadPath = path.join(BACKUP_DIR, `${file}.enc`);
      uploadKey = `${key}.enc`;
      contentType = "application/octet-stream";
      encryptFile(local, uploadPath, process.env.BACKUP_ENCRYPTION_KEY);
    }

    const res = await putFile(client, BUCKET, uploadKey, uploadPath, contentType);
    console.log(
      `[offsite] uploaded ${uploadKey} (${(res.sizeBytes / 1024 / 1024).toFixed(1)}MB)` +
        (uploadPath === local ? " — NOT ENCRYPTED, set BACKUP_ENCRYPTION_KEY" : " encrypted"),
    );

    // The local plaintext is the one kept on disk; the encrypted copy exists only to be uploaded.
    if (uploadPath !== local) fs.rmSync(uploadPath, { force: true });
    uploaded.push(res);
  }

  // Prune by exact key, newest kept, and only within the backups/ prefix — never a bucket-wide
  // sweep. Same rule as the media directory: delete what you listed, not what a pattern matches.
  for (const prefix of ["backups/db-", "backups/uploads-"]) {
    const remote = (await listKeys(client, BUCKET, prefix)).sort(
      (a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0),
    );
    const stale = remote.slice(KEEP_REMOTE).map((o) => o.key);
    if (stale.length > 0) {
      await deleteKeys(client, BUCKET, stale);
      console.log(`[offsite] pruned ${stale.length} old remote backup(s) under ${prefix}`);
    }
  }

  const all = await listKeys(client, BUCKET, "backups/");
  const totalMb = all.reduce((sum, o) => sum + (o.size ?? 0), 0) / 1024 / 1024;
  console.log(`[offsite] ${all.length} object(s) offsite, ${totalMb.toFixed(1)}MB total`);
}

main().catch((err) => {
  // Non-fatal by design: the local backup has already been written and verified by the time this
  // runs. Failing the whole job because Cloudflare was briefly unreachable would turn a partial
  // success into a reported failure and, worse, into a skipped rotation.
  console.error(`[offsite] upload failed: ${err.message}`);
  process.exitCode = 1;
});
