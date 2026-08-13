import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFPROBE_TIMEOUT_MS = 10_000;

export interface AudioProbeResult {
  hasAudio: boolean;
  durationMs: number;
  /**
   * File extension for the container ffprobe actually found — not the one the uploader's filename
   * claimed. The stored file is named with this so that static serving infers the right
   * Content-Type; a WAV saved as `.mp3` is served as audio/mpeg and simply will not decode.
   */
  extension: string;
}

/** ffprobe's format names are comma-separated lists of everything the container could be. */
function extensionFor(formatName: string): string {
  const formats = formatName.split(",").map((f) => f.trim());
  const map: Record<string, string> = {
    mp3: "mp3",
    ogg: "ogg",
    wav: "wav",
    webm: "webm",
    flac: "flac",
    matroska: "webm",
    mov: "m4a",
    mp4: "m4a",
    m4a: "m4a",
    aac: "aac",
  };
  for (const format of formats) {
    if (map[format]) return map[format];
  }
  return "bin";
}

/**
 * Reads the real duration of an uploaded audio file, and confirms it is audio at all.
 *
 * Locked down identically to modules/videos/transcode.ts's probeVideo, and for identical reasons —
 * the single most important flag is `-protocol_whitelist file`, without which a crafted container
 * (an HLS or concat playlist, say) makes ffprobe open http:// or file:// targets that the uploader
 * chose, from inside the Docker network where postgres and redis live. That is an SSRF and an
 * arbitrary-file-read in one, from a route whose only job is to measure a two-second sound.
 *
 * The rest: `-nostdin` so it can never block waiting for input, an argument array rather than a
 * shell string so a filename cannot inject shell syntax, and a wall-clock timeout.
 */
export async function probeAudio(filePath: string): Promise<AudioProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-nostdin",
        "-protocol_whitelist", "file",
        "-print_format", "json",
        "-show_entries", "format=duration,format_name:stream=codec_type",
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    return { hasAudio: false, durationMs: 0, extension: "bin" };
  }

  try {
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const hasAudio = (parsed.streams ?? []).some((s) => s.codec_type === "audio");
    // A container with a video stream is not a soundboard clip even if it also carries audio —
    // it would download and decode a video on everyone's device to play two seconds of noise.
    const hasVideo = (parsed.streams ?? []).some((s) => s.codec_type === "video");
    const durationSec = Number(parsed.format?.duration);
    if (!hasAudio || hasVideo || !Number.isFinite(durationSec) || durationSec <= 0) {
      return { hasAudio: false, durationMs: 0, extension: "bin" };
    }
    return {
      hasAudio: true,
      durationMs: Math.round(durationSec * 1000),
      extension: extensionFor(parsed.format?.format_name ?? ""),
    };
  } catch {
    return { hasAudio: false, durationMs: 0, extension: "bin" };
  }
}
