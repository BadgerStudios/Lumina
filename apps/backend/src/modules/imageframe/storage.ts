import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { env } from "../../config/env.js";

/**
 * Imageframe videos live in their own tree, separate from the TikTok-style `videos/` uploads: the
 * lifecycle differs (the source is kept, not deleted, so a screen can be re-prepared at a different
 * grid size) and the artifact is a palette frame-pack, not a streamable MP4.
 *
 *   source/  — the raw upload, kept for re-transcode
 *   packs/   — the .ifv frame pack the plugin pulls and caches (the "prepared" artifact)
 *   posters/ — a single first-frame PNG, for the resolving link's preview
 */
export const IF_DIRS = {
  source: () => path.join(env.UPLOADS_DIR, "imageframe", "source"),
  packs: () => path.join(env.UPLOADS_DIR, "imageframe", "packs"),
  posters: () => path.join(env.UPLOADS_DIR, "imageframe", "posters"),
};

export async function ensureImageframeDirs(): Promise<void> {
  await Promise.all(Object.values(IF_DIRS).map((dir) => fs.mkdir(dir(), { recursive: true })));
}

export class UploadTooLargeError extends Error {}

/**
 * Streams one uploaded video to disk, hashing as it goes — same reasoning as videos/storage.ts:
 * `part.toBuffer()` would hold the whole 100MB in the API's 768m container and OOM under a couple
 * of concurrent uploads. Truncation is signalled after the stream ends (`file.truncated`), so the
 * partial file is unlinked before throwing to avoid orphaning bytes on the volume.
 */
export async function streamUploadToDisk(
  part: MultipartFile,
  destKey: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  await ensureImageframeDirs();
  const destPath = path.join(IF_DIRS.source(), destKey);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, callback) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(part.file, meter, createWriteStream(destPath));
  } catch (err) {
    await safeUnlink(destPath);
    throw err;
  }
  if (part.file.truncated) {
    await safeUnlink(destPath);
    throw new UploadTooLargeError(`Video exceeds ${env.MAX_IMAGEFRAME_MB}MB`);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    /* already gone */
  }
}

export async function statSize(filePath: string): Promise<number | null> {
  try {
    const s = await fs.stat(filePath);
    return s.size;
  } catch {
    return null;
  }
}
