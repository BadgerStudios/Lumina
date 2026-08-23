import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VIDEO_DIRS, safeUnlink } from "./storage.js";
import { TranscodeError } from "./transcode.js";

const execFileAsync = promisify(execFile);

/**
 * Composing a stitch or a duet out of two clips.
 *
 * Runs in the worker, never in the API process — this is a second full encode on top of the
 * normal one, and it is exactly the kind of CPU spike the worker container exists to absorb.
 *
 * Every ffmpeg invocation here carries the same lockdown as transcode.ts: `-protocol_whitelist
 * file` so a crafted container can't make the decoder reach postgres or redis over the Docker
 * network, argument-array exec so no filename can inject shell syntax, and a wall-clock timeout.
 * The *source* side is a file this server produced (an already-transcoded MP4), but the creator's
 * own clip is a raw upload, so the guard has to hold.
 *
 * Neither side is actually guaranteed to have an audio stream. The source has been through
 * transcodeVideo, but that only encodes what's there — a silent screen recording or a camera clip
 * with no mic access transcodes to a video-only MP4. The creator's own clip is a raw upload and was
 * never guaranteed anything. A filter graph that references `[N:a]` on an input with no audio
 * stream fails to build at all, which used to crash the whole composition outright. `planAudioInputs`
 * below probes both sides and substitutes a silent `anullsrc` input for whichever one needs it.
 */

const FFMPEG_TIMEOUT_MS = 12 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

/** The composed canvas. Portrait, matching the feed's own 9:16 card — a duet rendered as a wide
 * 2:1 strip would letterbox to a sliver in a feed built for phones. */
const CANVAS_W = 1080;
const CANVAS_H = 1920;

/** Longest slice of someone else's video a stitch may quote. Short by design: a stitch is meant to
 * be a reply that starts by quoting, and the longer the quote the closer the feature gets to
 * "re-upload someone else's video with a comment on the end". */
export const MAX_STITCH_MS = 5000;
export const MIN_STITCH_MS = 500;

/**
 * Side-by-side. Each clip is fitted into half the canvas width and vertically centred, then the
 * pair is padded back out to full portrait height.
 *
 * `amix ... duration=shortest` plus `-shortest`: the composition ends when the shorter of the two
 * ends. The alternative — running to the longer one — leaves a frozen half-frame and silence for
 * however long the difference is, which reads as a broken video rather than a deliberate one.
 */
export async function composeDuet(sourcePath: string, ownPath: string, destPath: string): Promise<void> {
  const half = CANVAS_W / 2;
  const { extraInputArgs, ref0, ref1 } = await planAudioInputs(sourcePath, ownPath);
  const filter =
    `[0:v]scale=${half}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
    `pad=${half}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[l];` +
    `[1:v]scale=${half}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
    `pad=${half}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[r];` +
    `[l][r]hstack=inputs=2[v];` +
    `${ref0}${ref1}amix=inputs=2:duration=shortest:dropout_transition=0,volume=1.4[a]`;

  await run(
    [
      "-i", sourcePath,
      "-i", ownPath,
      ...extraInputArgs,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",
      "-shortest",
    ],
    destPath,
  );
}

/**
 * A slice of the source, then the creator's clip, end to end.
 *
 * concat demands that both segments agree on resolution, pixel format, SAR, frame rate and audio
 * sample rate — mismatch is not an error you get told about clearly, it is corrupt output or a
 * filter graph that refuses to build. Hence every normalisation in both branches is deliberate and
 * symmetric; the two chains must stay identical apart from the trim.
 */
export async function composeStitch(
  sourcePath: string,
  ownPath: string,
  destPath: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const start = (startMs / 1000).toFixed(3);
  const end = (endMs / 1000).toFixed(3);
  const { extraInputArgs, ref0, ref1 } = await planAudioInputs(sourcePath, ownPath);
  const normalise =
    `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
    `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;

  const filter =
    `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,${normalise}[v0];` +
    `${ref0}atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a0];` +
    `[1:v]${normalise}[v1];` +
    `${ref1}aresample=48000,aformat=channel_layouts=stereo[a1];` +
    `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;

  await run(
    [
      "-i", sourcePath,
      "-i", ownPath,
      ...extraInputArgs,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "[a]",
    ],
    destPath,
  );
}

/** Whether ffprobe finds any audio stream at all in the file. Best-effort: a probe failure is
 * treated as "no audio" rather than thrown, since the real decode happens in the ffmpeg run right
 * after — this only decides which filter graph to build. */
async function probeHasAudio(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-protocol_whitelist", "file",
        "-print_format", "json",
        "-show_entries", "stream=codec_type",
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    return parsed.streams?.some((s) => s.codec_type === "audio") ?? false;
  } catch {
    return false;
  }
}

/**
 * Works out which of the two inputs (0 = source, 1 = own clip) need a stand-in silent audio
 * track, and returns the filter-graph stream references (`[0:a]`/`[1:a]`, or `[2:a]`/`[3:a]` for
 * whichever needed an anullsrc input) alongside the extra `-i` args to append after the two real
 * inputs. Order matters: ref0 is resolved before ref1, so an anullsrc needed for the source always
 * lands at a lower input index than one needed for the own clip, matching the order extraInputArgs
 * is appended in.
 */
async function planAudioInputs(
  path0: string,
  path1: string,
): Promise<{ extraInputArgs: string[]; ref0: string; ref1: string }> {
  const [has0, has1] = await Promise.all([probeHasAudio(path0), probeHasAudio(path1)]);
  const extraInputArgs: string[] = [];
  let nextIndex = 2;
  const refFor = (has: boolean, idx: number): string => {
    if (has) return `[${idx}:a]`;
    extraInputArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    return `[${nextIndex++}:a]`;
  };
  return { extraInputArgs, ref0: refFor(has0, 0), ref1: refFor(has1, 1) };
}

async function run(args: string[], destPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-v", "error",
        "-protocol_whitelist", "file",
        "-y",
        ...args,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "24",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-threads", "2",
        destPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    await safeUnlink(destPath);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new TranscodeError(stderr.trim().split("\n").pop() || "Could not combine the two clips");
  }
}

/** Where a composition is staged before the normal pipeline picks it up. Lives in the source dir
 * because it IS the source from that point on, and is deleted with it once transcoded. */
export function composedSourcePath(videoId: bigint): string {
  return path.join(VIDEO_DIRS.source(), `${videoId}-composed.mp4`);
}
