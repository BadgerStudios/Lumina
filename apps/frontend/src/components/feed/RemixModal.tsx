import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Circle, Square, Upload, Loader2, RotateCcw } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";
import { videoMediaUrl, useUploadVideo } from "../../queries/videos";
import { useUploadLimits } from "../../queries/meta";
import { toast } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/**
 * Recording a stitch or a duet.
 *
 * The composition itself happens server-side in the transcode worker (see
 * modules/videos/remix.ts) — this only ever produces the creator's own clip and the parameters
 * describing what to combine it with. Doing the merge in the browser was the obvious alternative
 * and is the wrong one: it means a canvas-plus-MediaRecorder pipeline whose output quality and
 * codec support vary per browser, it re-encodes on the weakest device in the chain, and it puts
 * the attribution the whole feature depends on inside a file the client controls.
 *
 * Recording is optional. Not every device grants camera access, and a browser that refuses
 * getUserMedia should not mean "you cannot make a duet at all" — so picking an existing file is a
 * peer of recording, not a fallback tucked away somewhere.
 */

/** Matches MAX_STITCH_MS / MIN_STITCH_MS in modules/videos/remix.ts. Re-checked server-side. */
const MAX_STITCH_MS = 5000;
const MIN_STITCH_MS = 500;
const DEFAULT_STITCH_MS = 3000;

type Mode = "STITCH" | "DUET";

export function RemixModal({
  source,
  mode,
  onClose,
}: {
  source: VideoDTO | null;
  mode: Mode;
  onClose: () => void;
}) {
  const upload = useUploadVideo();
  const limits = useUploadLimits();
  const maxDurationSec = limits.data?.maxVideoDurationSec ?? 180;

  const sourceRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [clip, setClip] = useState<{ file: File; url: string } | null>(null);
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [stitchStartMs, setStitchStartMs] = useState(0);

  const sourceDurationMs = source?.durationMs ?? 0;
  const stitchLengthMs = Math.min(DEFAULT_STITCH_MS, Math.max(MIN_STITCH_MS, sourceDurationMs));
  const stitchEndMs = Math.min(stitchStartMs + stitchLengthMs, sourceDurationMs || stitchStartMs + stitchLengthMs);

  // --- camera ---------------------------------------------------------------------------------
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } },
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (cameraRef.current) {
          cameraRef.current.srcObject = stream;
          void cameraRef.current.play().catch(() => undefined);
        }
      } catch {
        // Denied, unavailable, or a non-secure context. Not fatal — the file picker below still
        // works, so this only removes the record button.
        if (!cancelled) setCameraError("Camera unavailable — you can still pick a file to remix with.");
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [source, stopStream]);

  // Releasing the object URL matters here more than usual: a recorded clip is tens of megabytes
  // held in memory, and this modal is opened and closed repeatedly while browsing a feed.
  useEffect(() => {
    return () => {
      if (clip) URL.revokeObjectURL(clip.url);
    };
  }, [clip]);

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream) return;

    chunksRef.current = [];
    // No explicit mimeType: Chrome produces webm, Safari mp4, and naming one that the browser
    // doesn't support makes the constructor throw. The worker re-encodes whatever arrives.
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      const ext = (recorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `remix-${Date.now()}.${ext}`, { type: blob.type });
      setClip({ file, url: URL.createObjectURL(blob) });
      setRecording(false);
    };

    recorder.start();
    setRecording(true);
    setElapsedMs(0);

    // The source plays alongside so the creator is reacting to something rather than to silence.
    // For a stitch, only the chosen slice plays.
    const el = sourceRef.current;
    if (el) {
      el.currentTime = mode === "STITCH" ? stitchStartMs / 1000 : 0;
      void el.play().catch(() => undefined);
    }
  };

  const stopRecording = useCallback(() => {
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
    sourceRef.current?.pause();
  }, []);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      setElapsedMs(ms);
      // A hard stop at the server's own duration cap. Letting someone record past it and only
      // finding out at upload wastes the whole take.
      if (ms >= maxDurationSec * 1000) stopRecording();
    }, 100);
    return () => clearInterval(timer);
  }, [recording, maxDurationSec, stopRecording]);

  const reset = () => {
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setElapsedMs(0);
  };

  const submit = async () => {
    if (!source || !clip) return;
    setProgress(0);
    try {
      await upload.mutateAsync({
        file: clip.file,
        caption,
        remix: {
          type: mode,
          sourceId: source.id,
          ...(mode === "STITCH" ? { startMs: stitchStartMs, endMs: stitchEndMs } : {}),
        },
        onProgress: (f) => setProgress(Math.round(f * 100)),
      });
      toast.success(
        mode === "DUET"
          ? "Duet uploaded — it'll appear once a moderator approves it."
          : "Stitch uploaded — it'll appear once a moderator approves it.",
      );
      stopStream();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  };

  if (!source) return null;
  const sourceSrc = videoMediaUrl(source.playbackUrl) ?? undefined;
  const busy = progress !== null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && (stopStream(), onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] flex max-h-[92vh] w-[min(92vw,44rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-lg bg-base-800 p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-signal">
              {mode === "DUET" ? "Duet" : "Stitch"} with @{source.author?.username ?? "someone"}
            </Dialog.Title>
            <Dialog.Close
              disabled={busy}
              onClick={stopStream}
              className="rounded p-1 text-signal-dim hover:text-signal disabled:opacity-40"
              aria-label="Close"
            >
              <X size={18} />
            </Dialog.Close>
          </div>

          <p className="mb-3 text-xs text-signal-faint">
            {mode === "DUET"
              ? "Your video plays side by side with theirs. They're credited on your post."
              : `The first ${(stitchEndMs - stitchStartMs) / 1000}s of their video plays, then yours. They're credited on your post.`}
          </p>

          {/* Two panes: theirs and yours, laid out the way the finished video will be. */}
          <div className={cn("grid gap-2", mode === "DUET" ? "grid-cols-2" : "grid-cols-2")}>
            <Pane label="Theirs">
              <video
                ref={sourceRef}
                src={sourceSrc}
                className="h-full w-full object-contain"
                playsInline
                controls={!recording}
              />
            </Pane>
            <Pane label={clip ? "Your take" : "You"}>
              {clip ? (
                <video src={clip.url} className="h-full w-full object-contain" playsInline controls loop />
              ) : (
                <video ref={cameraRef} className="h-full w-full object-cover" playsInline muted autoPlay />
              )}
            </Pane>
          </div>

          {mode === "STITCH" && sourceDurationMs > stitchLengthMs && (
            <label className="mt-3 flex flex-col gap-1">
              <span className="text-xs font-bold uppercase text-signal-dim">
                Start their clip at {(stitchStartMs / 1000).toFixed(1)}s
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, sourceDurationMs - stitchLengthMs)}
                step={100}
                value={stitchStartMs}
                disabled={recording || busy}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setStitchStartMs(next);
                  if (sourceRef.current) sourceRef.current.currentTime = next / 1000;
                }}
                className="accent-accent"
              />
            </label>
          )}

          {cameraError && <p className="mt-3 text-xs text-signal-faint">{cameraError}</p>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!clip && !cameraError && (
              <button
                type="button"
                onClick={recording ? stopRecording : startRecording}
                disabled={busy}
                className={cn(
                  "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white",
                  recording ? "bg-dnd hover:opacity-90" : "bg-accent hover:bg-accent-hover",
                )}
              >
                {recording ? <Square size={16} /> : <Circle size={16} />}
                {recording ? `Stop (${(elapsedMs / 1000).toFixed(1)}s)` : "Record"}
              </button>
            )}

            {!clip && (
              <label className="flex cursor-pointer items-center gap-2 rounded-full bg-base-600 px-4 py-2 text-sm font-medium text-signal hover:bg-base-500">
                <Upload size={16} />
                Use a file
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setClip({ file, url: URL.createObjectURL(file) });
                  }}
                />
              </label>
            )}

            {clip && !busy && (
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-2 rounded-full bg-base-600 px-4 py-2 text-sm font-medium text-signal hover:bg-base-500"
              >
                <RotateCcw size={16} />
                Retake
              </button>
            )}
          </div>

          <label className="mt-3 flex flex-col gap-1">
            <span className="text-xs font-bold uppercase text-signal-dim">Caption</span>
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={300}
              disabled={busy}
              placeholder="Say something about it…"
              className="rounded border-none bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            />
          </label>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!clip || busy}
            className="mt-4 flex items-center justify-center gap-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? `Uploading… ${progress}%` : `Post ${mode === "DUET" ? "duet" : "stitch"}`}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Pane({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative aspect-[9/16] max-h-[42vh] overflow-hidden rounded bg-black">
      {children}
      <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {label}
      </span>
    </div>
  );
}
