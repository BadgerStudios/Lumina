import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";

/**
 * Dedicated, leveled logger for the imageframe-video pipeline.
 *
 * The whole feature spans three hosts — the browser/uploader, this backend + its transcode worker,
 * and the Minecraft server running the plugin — and the ask was to "see if it works or not and
 * issues from all levels." So every stage funnels through here: upload acceptance, ffmpeg
 * transcode, frame-pack writes, HTTP serving, and (via POST /api/imageframe/log) the plugin's own
 * playback events. One tagged stream, written to BOTH the container's stdout (so it lands in
 * `docker logs` next to everything else) and a dedicated file under UPLOADS_DIR so it survives a
 * restart and can be tailed on its own without the rest of the app's noise drowning it.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Anything at or above this numeric threshold is emitted. Default `debug` in dev, `info` in prod —
// overridable with IMAGEFRAME_LOG_LEVEL so a live investigation can turn the firehose on without a
// redeploy.
const threshold = LEVELS[(env.IMAGEFRAME_LOG_LEVEL as LogLevel) ?? (env.NODE_ENV === "production" ? "info" : "debug")] ?? 20;

const LOG_DIR = path.join(env.UPLOADS_DIR, "imageframe");
const LOG_FILE = path.join(LOG_DIR, "imageframe.log");

let stream: fs.WriteStream | null = null;
function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // `flags: "a"` — append, never truncate; a redeploy must not wipe the history we're keeping it
    // around for. No rotation here on purpose: docker's json-file driver already caps and rotates
    // the stdout copy (compose.yml, 10m x3), and this file is the long-tail archive.
    stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    stream.on("error", () => {
      // A broken log sink must never take a request or a transcode down with it. Drop to stdout
      // only and stop trying the file.
      stream = null;
    });
    return stream;
  } catch {
    return null;
  }
}

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: `imageframe:${scope}`,
    message,
    ...(fields ?? {}),
  });
  // eslint-disable-next-line no-console
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
  fileStream()?.write(line + "\n");
}

export interface IframeLog {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A scoped logger: `const log = ifLog("transcode")` tags every line `imageframe:transcode`. */
export function ifLog(scope: string): IframeLog {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
  };
}

export const LOG_FILE_PATH = LOG_FILE;
