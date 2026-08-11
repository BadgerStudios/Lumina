import { useEffect, useRef, useState } from "react";
import { X, Upload, Loader2 } from "lucide-react";
import { useUploadVideo } from "../../queries/videos";
import { TagPicker } from "./TagPicker";
import { useUploadLimits } from "../../queries/meta";

/** Fallbacks only. The real caps come from GET /api/meta/limits so the client can never believe
 * the ceiling is higher than the server's — which would turn an instant "that's too big" into a
 * long upload that ends in a rejection. */
const FALLBACK_MAX_MB = 90;
const FALLBACK_MAX_DURATION_SEC = 180;

/** How long to wait for the browser to report a file's duration before giving up on the local
 * check. Generous, because reading metadata off a large file on a phone is not instant. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Reads duration from a locally-selected file before anything is sent, as an OPTIMISATION ONLY.
 *
 * This exists so an over-long video is rejected instantly instead of after the user waits out a
 * 100MB upload. It is deliberately never allowed to block an upload:
 *
 *  - It used to have no timeout. A `<video>` element handed a file the platform can't decode can
 *    settle NEITHER `loadedmetadata` NOR `error` — it just sits there. The promise never resolved,
 *    so `setFile` was never reached and the modal showed no file, no error and no spinner. The
 *    upload button stayed disabled forever and pressing it did nothing, with nothing on screen to
 *    explain why and nothing reaching the server to diagnose from.
 *  - It also used to REJECT when the browser couldn't decode the file, which refused perfectly
 *    valid uploads. Phone cameras routinely produce HEVC/H.265 and 10-bit HDR that a browser
 *    won't play but ffmpeg transcodes without complaint — and ffprobe on the server is the actual
 *    authority on duration anyway.
 *
 * So: a failure or a timeout resolves with a null duration and the upload proceeds. The server
 * enforces the real limit and returns a real message.
 */
function probeLocalVideo(file: File): Promise<{ durationSec: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    let settled = false;
    const finish = (durationSec: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve({ durationSec });
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      // Infinity/NaN are both real outcomes for streamed or fragmented containers.
      finish(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

/** Android's picker and some file managers hand back an empty or `application/octet-stream` MIME
 * type for a perfectly ordinary video, so the extension is the fallback rather than a hard refusal
 * on type alone. */
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ogv|mpg|mpeg|ts|hevc)$/i;

function looksLikeVideo(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name);
}

export function FeedUploadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Non-fatal explanation (e.g. the browser could not read the duration). */
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  // Default on, matching the server default and every platform that has this feature. Presented as
  // an opt-OUT rather than an opt-in because burying consent behind a checkbox nobody ticks is how
  // a remix feature ends up with nothing to remix.
  const [allowStitch, setAllowStitch] = useState(true);
  const [allowDuet, setAllowDuet] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadVideo();
  const { data: limits } = useUploadLimits();
  const maxMb = limits?.maxVideoUploadMb ?? FALLBACK_MAX_MB;
  const maxDurationSec = limits?.maxVideoDurationSec ?? FALLBACK_MAX_DURATION_SEC;

  // Persistent-singleton modal: this component stays mounted across opens, so every piece of state
  // must be resynced on open or the previous upload's file, caption and error bleed into the next.
  useEffect(() => {
    if (open) {
      setFile(null);
      setCaption("");
      setTags([]);
      setError(null);
      setNotice(null);
      setChecking(false);
      setProgress(0);
      setDone(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSelect = async (selected: File | null) => {
    setError(null);
    setNotice(null);
    setFile(null);
    if (!selected) return;

    if (!looksLikeVideo(selected)) {
      setError(`"${selected.name}" doesn't look like a video file.`);
      return;
    }
    if (selected.size > maxMb * 1024 * 1024) {
      setError(`That video is ${(selected.size / 1024 / 1024).toFixed(0)}MB — the limit is ${maxMb}MB.`);
      return;
    }

    // Visible state for the whole probe. Without it the modal looked completely inert while the
    // browser chewed through a large file's metadata.
    setChecking(true);
    const { durationSec } = await probeLocalVideo(selected);
    setChecking(false);

    if (durationSec !== null && durationSec > maxDurationSec) {
      setError(`That video is ${Math.round(durationSec)}s long — the limit is ${maxDurationSec}s.`);
      return;
    }
    if (durationSec === null) {
      // Not an error. The file is accepted and the server decides — this only explains why the
      // usual instant length check didn't happen.
      setNotice("Couldn't read this video's length here — it'll be checked after upload.");
    }
    setFile(selected);
  };

  const handleUpload = () => {
    if (!file) return;
    setError(null);
    upload.mutate(
      { file, caption, tags, allowStitch, allowDuet, onProgress: setProgress },
      {
        onSuccess: () => setDone(true),
        onError: (err) => setError((err as Error).message),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-base-800 p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg text-signal">Upload a video</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-signal-faint hover:text-signal">
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="text-sm text-signal-dim">
              Uploaded. It's being processed, then a moderator reviews it before it appears in the
              feed — you'll find its status under <span className="text-signal">My videos</span>.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              // Extensions listed alongside video/* because some Android pickers filter strictly on
              // MIME type and hide real videos they have reported as octet-stream — which made the
              // file unpickable rather than merely unvalidated.
              accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi,.3gp"
              className="hidden"
              onChange={(e) => void handleSelect(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={upload.isPending || checking}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-hairline px-4 py-8 text-signal-dim hover:border-accent hover:text-signal disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
              <span className="max-w-full truncate text-sm">
                {checking ? "Reading video…" : file ? file.name : "Choose a video"}
              </span>
              <span className="text-xs text-signal-faint">
                Up to {maxMb}MB, {Math.round(maxDurationSec / 60)} minutes
              </span>
            </button>

            <textarea
              aria-label="Caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, 300))}
              placeholder="Add a caption (optional)"
              rows={2}
              disabled={upload.isPending}
              className="w-full resize-none rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none disabled:opacity-50"
            />

            <TagPicker tags={tags} onChange={setTags} disabled={upload.isPending} />

            <fieldset className="rounded-lg border border-hairline p-3">
              <legend className="px-1 text-xs font-bold uppercase text-signal-dim">Let others remix this</legend>
              <div className="flex flex-col gap-2">
                <RemixToggle
                  label="Duets"
                  detail="Someone can film alongside your video."
                  checked={allowDuet}
                  disabled={upload.isPending}
                  onChange={setAllowDuet}
                />
                <RemixToggle
                  label="Stitches"
                  detail="Someone can quote a few seconds before their own clip."
                  checked={allowStitch}
                  disabled={upload.isPending}
                  onChange={setAllowStitch}
                />
              </div>
              <p className="mt-2 text-xs text-signal-faint">You can change this later from My videos.</p>
            </fieldset>

            {error && <p className="text-sm text-flare">{error}</p>}
            {!error && notice && <p className="text-sm text-amber">{notice}</p>}

            {upload.isPending && (
              <div className="space-y-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-base-600">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-signal-faint">
                  {progress >= 1 ? "Finishing up…" : `Uploading… ${Math.round(progress * 100)}%`}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleUpload}
              disabled={!file || upload.isPending || checking}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {upload.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Upload
            </button>

            <p className="text-xs text-signal-faint">
              Every upload is reviewed by a moderator before it appears publicly.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RemixToggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-sm text-signal">{label}</span>
        <span className="block text-xs text-signal-faint">{detail}</span>
      </span>
    </label>
  );
}
