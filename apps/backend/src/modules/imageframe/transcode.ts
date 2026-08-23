import path from "node:path";
import fs from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { IF_DIRS, ensureImageframeDirs, safeUnlink } from "./storage.js";
import { PALETTE_VERSION, quantizeFrame } from "./palette.js";
import { ifLog } from "./logger.js";

const execFileAsync = promisify(execFile);
const log = ifLog("transcode");

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const TILE = 128; // a map is 128x128 px

/** Pack format constants — kept in lockstep with the plugin's reader. */
const MAGIC = "IFV1";
const HEADER_BYTES = 32;
const FORMAT_VERSION = 1;

export class ImageframeTranscodeError extends Error {}

interface Probe {
  durationMs: number;
  width: number;
  height: number;
}

async function probe(sourcePath: string): Promise<Probe> {
  let stdout: string;
  try {
    // `-protocol_whitelist file` is the load-bearing flag (see videos/transcode.ts): without it a
    // crafted container can make ffmpeg open http:// or file:// targets — SSRF + arbitrary-read from
    // inside the docker network. Argument-array exec, never a shell string; wall-clock timeout.
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-protocol_whitelist", "file",
        "-print_format", "json",
        "-show_entries", "format=duration:stream=width,height,codec_type",
        sourcePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new ImageframeTranscodeError("File could not be read as video");
  }
  let parsed: { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ImageframeTranscodeError("File could not be read as video");
  }
  const v = parsed.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v?.height) throw new ImageframeTranscodeError("File contains no video stream");
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new ImageframeTranscodeError("Could not determine duration");
  if (durationSec > env.MAX_VIDEO_DURATION_SEC) {
    throw new ImageframeTranscodeError(`Video is ${Math.round(durationSec)}s — the limit is ${env.MAX_VIDEO_DURATION_SEC}s`);
  }
  return { durationMs: Math.round(durationSec * 1000), width: v.width, height: v.height };
}

/** RLE-encode one full-screen frame of map bytes: [count:u8][value:u8] pairs, runs 1..255. */
function rleEncode(bytes: Uint8Array): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const val = bytes[i]!;
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === val && run < 255) run++;
    out.push(run, val);
    i += run;
  }
  return Buffer.from(out);
}

/** Extract a single poster frame as PNG, scaled to the screen box. Best-effort — a missing poster
 * never fails a transcode, it just costs the resolving link its thumbnail. */
async function writePoster(sourcePath: string, posterPath: string, w: number, h: number): Promise<boolean> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin", "-protocol_whitelist", "file", "-y",
        "-i", sourcePath,
        "-frames:v", "1",
        "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
        posterPath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams the source through ffmpeg as raw rgb24 at the target grid resolution and fps, quantizes
 * each frame to the map palette, RLE-encodes it, and appends it to the .ifv pack. Frames are
 * assembled from ffmpeg's stdout in fixed W*H*3 slices and processed one at a time so a 180s clip
 * never holds more than a single frame of raw pixels in memory.
 */
export async function processImageframe(
  id: bigint,
  opts?: {
    /** Whether this is the last attempt BullMQ will make for this job. Defaults to true so any
     * caller that doesn't pass it gets the safe, terminal behaviour. See the catch block below —
     * this function used to never throw at all, which was worse than the equivalent video-pipeline
     * bug already fixed this session: it wasn't that retries silently no-op'd, it's that BullMQ
     * never even knew a retry was warranted, since a promise that resolves (rather than rejects) on
     * failure reads as success. `attempts`/`backoff` in queue.ts were entirely inert. */
    isFinalAttempt?: boolean;
  },
): Promise<void> {
  const row = await prisma.imageframeVideo.findUnique({ where: { id } });
  if (!row) {
    log.warn("row vanished before transcode", { id: id.toString() });
    return;
  }
  await ensureImageframeDirs();
  const sourcePath = path.join(IF_DIRS.source(), row.sourceKey);
  const packKey = `${row.sourceKey}.ifv`;
  const packPath = path.join(IF_DIRS.packs(), packKey);
  const posterKey = `${row.sourceKey}.png`;
  const posterPath = path.join(IF_DIRS.posters(), posterKey);

  const cols = row.gridCols;
  const rows = row.gridRows;
  const fps = row.fps;
  const W = cols * TILE;
  const H = rows * TILE;
  const frameBytes = W * H * 3;
  const maxFrames = Math.ceil((env.MAX_VIDEO_DURATION_SEC + 1) * fps);

  log.info("transcode start", { code: row.code, id: id.toString(), cols, rows, fps, W, H });

  const meta = await probe(sourcePath);

  const handle = await fs.open(packPath, "w");
  let frameCount = 0;
  try {
    // Reserve the header; frameCount/durationMs are patched in after the stream ends.
    const header = Buffer.alloc(HEADER_BYTES);
    header.write(MAGIC, 0, "ascii");
    header.writeUInt8(FORMAT_VERSION, 4);
    header.writeUInt8(PALETTE_VERSION, 5);
    header.writeUInt16LE(cols, 6);
    header.writeUInt16LE(rows, 8);
    header.writeUInt16LE(fps, 10);
    header.writeUInt16LE(TILE, 20);
    await handle.write(header, 0, HEADER_BYTES, 0);
    let writeOffset = HEADER_BYTES;

    const mapBytes = new Uint8Array(W * H);
    const lenBuf = Buffer.alloc(4);

    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        [
          "-nostdin", "-protocol_whitelist", "file",
          "-i", sourcePath,
          "-vf", `fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
          "-f", "rawvideo", "-pix_fmt", "rgb24",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const killTimer = setTimeout(() => {
        log.error("ffmpeg timed out, killing", { code: row.code });
        ff.kill("SIGKILL");
      }, FFMPEG_TIMEOUT_MS);

      let pending: Buffer[] = [];
      let pendingLen = 0;
      let backpressure: Promise<void> = Promise.resolve();
      let stderrTail = "";

      ff.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
      });

      const processFrame = async (frame: Buffer): Promise<void> => {
        quantizeFrame(frame, mapBytes);
        const payload = rleEncode(mapBytes);
        lenBuf.writeUInt32LE(payload.length, 0);
        await handle.write(lenBuf, 0, 4, writeOffset);
        writeOffset += 4;
        await handle.write(payload, 0, payload.length, writeOffset);
        writeOffset += payload.length;
        frameCount++;
      };

      ff.stdout.on("data", (chunk: Buffer) => {
        pending.push(chunk);
        pendingLen += chunk.length;
        if (pendingLen < frameBytes) return;
        // Pause while we drain full frames to disk — this is the backpressure that keeps memory flat
        // even if ffmpeg outpaces the quantizer.
        ff.stdout.pause();
        backpressure = backpressure.then(async () => {
          const joined = Buffer.concat(pending);
          let off = 0;
          while (joined.length - off >= frameBytes && frameCount < maxFrames) {
            await processFrame(joined.subarray(off, off + frameBytes));
            off += frameBytes;
          }
          const rem = joined.subarray(off);
          pending = rem.length ? [Buffer.from(rem)] : [];
          pendingLen = pending.length ? rem.length : 0;
          if (frameCount >= maxFrames) {
            log.warn("hit max frame cap, stopping", { code: row.code, maxFrames });
            ff.kill("SIGKILL");
          }
          ff.stdout.resume();
        }).catch(reject);
      });

      ff.on("error", (err) => {
        clearTimeout(killTimer);
        reject(new ImageframeTranscodeError(`ffmpeg failed to start: ${err.message}`));
      });

      ff.on("close", (code) => {
        clearTimeout(killTimer);
        // Let the last backpressure drain settle, then resolve. A non-zero exit is only fatal if we
        // captured no frames — a SIGKILL from our own frame cap exits non-zero by design.
        backpressure.then(() => {
          if (frameCount === 0) {
            reject(new ImageframeTranscodeError(`ffmpeg produced no frames (exit ${code}): ${stderrTail.slice(-300)}`));
          } else {
            resolve();
          }
        }).catch(reject);
      });
    });

    // Patch the now-known counts into the reserved header.
    const patch = Buffer.alloc(8);
    patch.writeUInt32LE(frameCount, 0);
    patch.writeUInt32LE(meta.durationMs, 4);
    await handle.write(patch, 0, 8, 12);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    // The partial pack is safe to clear on every attempt, final or not: a retry re-opens and
    // rewrites packPath from scratch regardless (sourcePath, the thing a retry actually needs, is
    // never touched here). Only the terminal DB status is held back for the final attempt.
    await safeUnlink(packPath);
    const message = err instanceof ImageframeTranscodeError ? err.message : "transcode failed";
    log.error("transcode failed", { code: row.code, id: id.toString(), error: message, isFinalAttempt: opts?.isFinalAttempt ?? true });
    if (opts?.isFinalAttempt ?? true) {
      await prisma.imageframeVideo.update({
        where: { id },
        data: { status: "FAILED", failureReason: message.slice(0, 300) },
      });
    }
    throw err;
  }
  await handle.close();

  const posterOk = await writePoster(sourcePath, posterPath, W, H);
  const packStat = await fs.stat(packPath).catch(() => null);

  await prisma.imageframeVideo.update({
    where: { id },
    data: {
      status: "READY",
      packKey,
      posterKey: posterOk ? posterKey : null,
      durationMs: meta.durationMs,
      srcWidth: meta.width,
      srcHeight: meta.height,
      frameCount,
      paletteVersion: PALETTE_VERSION,
      failureReason: null,
    },
  });

  log.info("transcode ready", {
    code: row.code,
    id: id.toString(),
    frameCount,
    packBytes: packStat?.size ?? null,
    durationMs: meta.durationMs,
    poster: posterOk,
  });
}
