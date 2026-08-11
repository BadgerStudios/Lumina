// Shared R2 (S3-compatible) helper for the two things that need offsite storage: nightly backups
// and published app releases.
//
// One module for both, but deliberately TWO buckets — see publish-release.mjs. Backups hold
// password hashes, email addresses and dates of birth and must never be public; releases are
// downloads that must be. A single bucket cannot be both, and the failure mode of getting that
// wrong is not recoverable by fixing it afterwards.
//
// Credentials come from the environment only. Nothing here ever writes a key to disk or logs one.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";

/** Reads .env without pulling in a dependency, and without overriding anything already exported. */
export function loadEnv(repoDir = path.resolve(import.meta.dirname, "..")) {
  try {
    const raw = readFileSync(path.join(repoDir, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env — rely on the real environment */
  }
}

export function r2Configured() {
  return Boolean(
    process.env.BACKUP_S3_ENDPOINT &&
      process.env.BACKUP_S3_KEY_ID &&
      process.env.BACKUP_S3_SECRET,
  );
}

export function r2Client() {
  if (!r2Configured()) {
    throw new Error(
      "R2 is not configured. Set BACKUP_S3_ENDPOINT, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET in .env",
    );
  }
  return new S3Client({
    // R2 ignores the region but the SDK requires one. "auto" is what Cloudflare documents.
    region: "auto",
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.BACKUP_S3_KEY_ID,
      secretAccessKey: process.env.BACKUP_S3_SECRET,
    },
  });
}

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Uploads a file.
 *
 * The digest is sent as object metadata as well as being recorded in the release manifest, so a
 * corrupted or truncated upload is detectable against the object itself rather than only against a
 * separate file that might not have been updated at the same time.
 */
export async function putFile(client, bucket, key, filePath, contentType, cacheControl) {
  const body = readFileSync(filePath);
  const digest = createHash("sha256").update(body).digest("hex");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Set on the OBJECT, not just in nginx's response headers. Cloudflare's edge caches R2
      // objects served over a custom domain and honours the object's own Cache-Control — so a
      // header added by our proxy is applied too late to stop the edge holding a stale copy.
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
      Metadata: { sha256: digest },
    }),
  );
  return { key, sizeBytes: body.length, sha256: digest };
}

export async function listKeys(client, bucket, prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) out.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Deletes by exact key, never by prefix sweep — the same rule that applies to the media directory
 * after this codebase once lost every video to a glob. */
export async function deleteKeys(client, bucket, keys) {
  if (keys.length === 0) return;
  // The command is passed as-is, never spread into a plain object: spreading copies the fields but
  // drops the prototype, so `resolveMiddleware` disappears and send() throws. That failure only
  // shows up the first time retention is actually exceeded — a month after deployment, on the one
  // code path nobody watches.
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
}

export async function getObject(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
