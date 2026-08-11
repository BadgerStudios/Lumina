import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { VIDEO_DIRS, ensureVideoDirs, safeUnlink } from "./storage.js";
import { composeDuet, composeStitch, composedSourcePath } from "./remix.js";

const execFileAsync = promisify(execFile);

/** Hard ceiling on a single ffmpeg invocation. A malformed or adversarial file can make a decoder
 * spin far longer than its duration would suggest, so wall-clock is the backstop that the duration
 * cap alone doesn't provide. */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

export class TranscodeError extends Error {}

interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
}

/**
 * ffprobe is run against a file uploaded by an untrusted user, so the invocation is locked down:
 *
 * - `-protocol_whitelist file` — without it a crafted container (an HLS/concat playlist, say) can
 *   make ffmpeg open http:// or file:// targets of the attacker's choosing. That is an SSRF and
 *   arbitrary-file-read primitive from inside the Docker network, next to postgres and redis. This
 *   is the single most important flag here.
 * - `-nostdin` — never block forever waiting on input it will not get.
 * - argument-array exec (never a shell string), so a filename can't inject shell syntax.
 * - a wall-clock timeout on every call.
 */
export async function probeVideo(sourcePath: string): Promise<ProbeResult> {
  let stdout: string;
  try {
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
    throw new TranscodeError("File could not be read as video");
  }

  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number; codec_type?: string }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new TranscodeError("File could not be read as video");
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  if (!videoStream?.width || !videoStream?.height) {
    throw new TranscodeError("File contains no video stream");
  }

  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new TranscodeError("Could not determine video duration");
  }
  if (durationSec > env.MAX_VIDEO_DURATION_SEC) {
    throw new TranscodeError(
      `Video is ${Math.round(durationSec)}s — the limit is ${env.MAX_VIDEO_DURATION_SEC}s`,
    );
  }

  return {
    durationMs: Math.round(durationSec * 1000),
    width: videoStream.width,
    height: videoStream.height,
  };
}

/**
 * Normalizes any accepted upload to a single streamable format, so the client only ever plays
 * H.264/AAC MP4 and never has to care what was uploaded.
 *
 * `-movflags +faststart` is not optional: by default the moov atom (the index) is written at the
 * END of an MP4, which forces a player to download the entire file before it can start. In a feed
 * where every scroll starts a new video that reads as "the feed is broken". This relocates the
 * index to the front in a second pass.
 *
 * The scale filter caps the long edge at 1080p while preserving aspect ratio, and `-2` keeps both
 * dimensions even (H.264 requires it — an odd dimension is a hard encoder failure). `-threads 2`
 * bounds CPU so one video can't monopolise the box.
 */
export async function transcodeVideo(sourcePath: string, destPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-v", "error",
        "-protocol_whitelist", "file",
        "-y",
        "-i", sourcePath,
        "-vf", "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=-2:trunc(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "26",
        "-profile:v", "main",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-movflags", "+faststart",
        "-threads", "2",
        destPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    await safeUnlink(destPath);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new TranscodeError(stderr.trim().split("\n").pop() || "Transcode failed");
  }
}

/** Single frame ~1s in (or at the start for very short clips), used as the feed poster image so a
 * card shows something before its video is buffered. */
export async function generateThumbnail(
  sourcePath: string,
  destPath: string,
  durationMs: number,
): Promise<void> {
  const seekSec = durationMs > 2000 ? 1 : 0;
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-v", "error",
        "-protocol_whitelist", "file",
        "-y",
        "-ss", String(seekSec),
        "-i", sourcePath,
        "-frames:v", "1",
        "-vf", "scale='min(720,iw)':-2",
        "-q:v", "4",
        destPath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    await safeUnlink(destPath);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new TranscodeError(stderr.trim().split("\n").pop() || "Thumbnail generation failed");
  }
}

/**
 * Full pipeline for one uploaded video: probe → transcode → thumbnail → PENDING_REVIEW.
 *
 * Lands in PENDING_REVIEW, never APPROVED — transcoding is a mechanical step and explicitly not a
 * moderation decision. A human still has to approve before anything reaches the public feed.
 *
 * Any TranscodeError becomes a FAILED row carrying a reason the uploader can actually read, rather
 * than a video stuck in PROCESSING forever with no explanation.
 */
export async function processVideo(videoId: bigint): Promise<void> {
  const video = await prisma.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  // Guards against a duplicate/replayed job re-transcoding something already decided — including
  // re-publishing a video a moderator has since removed.
  if (video.status !== "PROCESSING") return;

  await ensureVideoDirs();
  const uploadPath = path.join(VIDEO_DIRS.source(), video.sourceKey);
  const playbackKey = `${video.id}.mp4`;
  const thumbnailKey = `${video.id}.jpg`;
  const playbackPath = path.join(VIDEO_DIRS.playback(), playbackKey);
  const thumbnailPath = path.join(VIDEO_DIRS.thumbs(), thumbnailKey);

  // A stitch or duet is composed first, and everything downstream then treats the composition as
  // the source. Two encodes rather than folding the composition into the main transcode: doing it
  // this way means a remix inherits every guarantee the normal pipeline already provides
  // (duration cap, 1080 ceiling, faststart, AAC) instead of a second code path having to restate
  // them and drift.
  let sourcePath = uploadPath;
  let composedPath: string | null = null;

  try {
    if (video.derivativeType) {
      composedPath = composedSourcePath(video.id);
      await composeDerivative(video, uploadPath, composedPath);
      sourcePath = composedPath;
    }

    const probe = await probeVideo(sourcePath);
    await transcodeVideo(sourcePath, playbackPath);
    await generateThumbnail(playbackPath, thumbnailPath, probe.durationMs);

    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: "PENDING_REVIEW",
        playbackKey,
        thumbnailKey,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        failureReason: null,
      },
    });

    // Only now, once the derivative is definitely playable, does the source's counter move — a
    // remix that failed to compose must not inflate "12 people remixed this".
    if (video.derivativeType && video.sourceVideoId !== null) {
      await prisma.video.update({
        where: { id: video.sourceVideoId },
        data: { derivativeCount: { increment: 1 } },
      });
    }

    // The original is redundant once a playable copy exists, and video is by far the largest thing
    // this instance stores — keeping both would roughly double the volume's growth rate.
    await safeUnlink(uploadPath);
    if (composedPath) await safeUnlink(composedPath);
  } catch (err) {
    const reason = err instanceof TranscodeError ? err.message : "Unexpected error while processing";
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "FAILED", failureReason: reason.slice(0, 500) },
    });
    await Promise.all([
      safeUnlink(playbackPath),
      safeUnlink(thumbnailPath),
      safeUnlink(uploadPath),
      ...(composedPath ? [safeUnlink(composedPath)] : []),
    ]);
    throw err;
  }
}

/**
 * Builds the composed clip a stitch/duet is really made of.
 *
 * The source side is read from the *playback* copy, never the original upload: the upload is
 * deleted the moment a video is transcoded (see above), so it does not exist for anything old
 * enough to be in the feed. The playback copy is also already normalised H.264/AAC, which is what
 * makes concat and hstack behave.
 */
async function composeDerivative(
  video: { id: bigint; sourceVideoId: bigint | null; derivativeType: string | null; sourceStartMs: number | null; sourceEndMs: number | null },
  uploadPath: string,
  destPath: string,
): Promise<void> {
  if (video.sourceVideoId === null) {
    throw new TranscodeError("The video this was made from no longer exists");
  }
  const source = await prisma.video.findUnique({
    where: { id: video.sourceVideoId },
    select: { playbackKey: true, status: true },
  });
  // Deleted, or taken down between the upload starting and the worker picking it up. Failing here
  // is the right outcome: silently publishing a remix of removed footage is the one thing this
  // must not do.
  if (!source?.playbackKey || source.status !== "APPROVED") {
    throw new TranscodeError("The video this was made from is no longer available");
  }
  const sourcePlayback = path.join(VIDEO_DIRS.playback(), source.playbackKey);

  if (video.derivativeType === "DUET") {
    await composeDuet(sourcePlayback, uploadPath, destPath);
  } else {
    await composeStitch(
      sourcePlayback,
      uploadPath,
      destPath,
      video.sourceStartMs ?? 0,
      video.sourceEndMs ?? 3000,
    );
  }
}
