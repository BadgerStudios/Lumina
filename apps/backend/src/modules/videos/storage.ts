import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { env } from "../../config/env.js";

/** Video files live outside the `attachments/` tree since they have a different lifecycle
 * (source is deleted after transcoding) and a different access-control story (no channel/DM
 * membership to check — approval status governs instead). */
export const VIDEO_DIRS = {
  source: () => path.join(env.UPLOADS_DIR, "videos", "source"),
  playback: () => path.join(env.UPLOADS_DIR, "videos", "playback"),
  thumbs: () => path.join(env.UPLOADS_DIR, "videos", "thumbs"),
};

export async function ensureVideoDirs(): Promise<void> {
  await Promise.all(Object.values(VIDEO_DIRS).map((dir) => fs.mkdir(dir(), { recursive: true })));
}

export class UploadTooLargeError extends Error {}

/**
 * Streams one uploaded video part straight to disk, hashing as it goes.
 *
 * Deliberately does NOT use `part.toBuffer()`, which is how every other upload in this codebase
 * works (see modules/messages/multipart.ts): toBuffer holds the entire file in memory, which is
 * survivable for a 25MB image and is not for a 100MB video on a container with mem_limit 768m —
 * a couple of concurrent uploads would OOM the API process. Streaming keeps memory flat regardless
 * of file size.
 *
 * The SHA-256 is computed in a pass-through Transform rather than by attaching a `data` listener:
 * adding a `data` handler flips the stream into flowing mode out from under `pipeline`, which can
 * drop chunks. Hashing inline costs one pass over bytes already in flight.
 *
 * On truncation (@fastify/multipart signals the limit by setting `file.truncated` AFTER the stream
 * ends, not by throwing) the partial file is deleted before throwing, so a rejected oversize upload
 * cannot leave orphaned bytes on disk — which would otherwise be a trivial way to fill the volume.
 */
export async function streamUploadToDisk(
  part: MultipartFile,
  destKey: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  await ensureVideoDirs();
  const destPath = path.join(VIDEO_DIRS.source(), destKey);

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
    throw new UploadTooLargeError(`Video exceeds ${env.MAX_VIDEO_UPLOAD_MB}MB`);
  }

  return { sizeBytes, sha256: hash.digest("hex") };
}

/** Unlink that never throws — used on cleanup paths where the file may already be gone and where
 * masking the original error with an ENOENT would be actively unhelpful. */
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
