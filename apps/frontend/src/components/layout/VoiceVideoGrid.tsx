import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useVoiceStore, getLocalVideoStream, getRemoteVideoStream } from "../../store/voiceStore";
import { useAuthStore } from "../../store/authStore";
import { cn } from "../../lib/cn";

function VideoTile({ label, stream, muted, speaking, live, focused, onClick }: {
  label: string;
  stream: MediaStream;
  muted?: boolean;
  speaking?: boolean;
  live?: boolean;
  focused?: boolean;
  onClick?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg bg-base-900 text-left",
        focused ? "h-full w-full" : "aspect-video w-48",
        speaking && "ring-2 ring-online",
      )}
      title={focused ? "Click to shrink" : "Click to expand"}
    >
      {/* A focused screen stream must never be cropped — the whole point is reading its content —
          so the theater view letterboxes (contain) while thumbnails stay filled (cover). */}
      <video ref={videoRef} autoPlay playsInline muted={muted} className={cn("h-full w-full", focused ? "object-contain" : "object-cover")} />
      <span className="absolute bottom-1 left-1.5 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        {live ? <span className="rounded bg-dnd px-1 py-px text-[9px] font-bold uppercase tracking-wide">Live</span> : null}
        {label}
      </span>
    </button>
  );
}

/**
 * A floating overlay (not tied to whichever text channel/DM is currently open) rather than
 * something rendered inside ChatPane — voice connection state is global, independent of the
 * route you're viewing (you can be in a voice call while reading a completely different text
 * channel), so this is mounted once at the AppShell level like ModalRoot.
 *
 * Clicking a tile opens the theater view: that stream fills most of the viewport (essential for
 * actually watching a Go Live screen share) with the remaining tiles in a strip beneath it.
 */
export function VoiceVideoGrid() {
  const channelId = useVoiceStore((s) => s.channelId);
  const videoSource = useVoiceStore((s) => s.videoSource);
  const participants = useVoiceStore((s) => s.participants);
  const roster = useVoiceStore((s) => (s.channelId ? s.roster[s.channelId] : undefined));
  const user = useAuthStore((s) => s.user);
  // "local" | socketId | null. Cleared when the focused stream goes away below.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const remoteWithVideo = Object.values(participants).filter((p) => p.hasVideo);
  const focusedGone =
    focusedId !== null &&
    (focusedId === "local" ? !videoSource : !remoteWithVideo.some((p) => p.socketId === focusedId));
  useEffect(() => {
    if (focusedGone) setFocusedId(null);
  }, [focusedGone]);

  if (!channelId || (!videoSource && remoteWithVideo.length === 0)) return null;

  const localStream = videoSource ? getLocalVideoStream() : null;
  const streamKind = (socketId: string) => roster?.find((r) => r.socketId === socketId)?.streaming ?? null;
  const focusedOpen = focusedId !== null && !focusedGone;

  const tiles = [
    ...(localStream && user
      ? [{
          id: "local",
          label: `You${videoSource === "screen" ? " (screen)" : ""}`,
          stream: localStream,
          muted: true,
          speaking: false,
          live: videoSource === "screen",
        }]
      : []),
    ...remoteWithVideo.flatMap((p) => {
      const stream = getRemoteVideoStream(p.socketId);
      if (!stream) return [];
      return [{
        id: p.socketId,
        label: p.user.displayName ?? p.user.username,
        stream,
        muted: false,
        speaking: p.speaking,
        live: streamKind(p.socketId) === "screen",
      }];
    }),
  ];
  const focusedTile = focusedOpen ? tiles.find((t) => t.id === focusedId) : undefined;

  if (focusedTile) {
    return (
      <div className="fixed inset-2 z-40 flex flex-col gap-2 rounded-xl bg-base-900/95 p-3 shadow-2xl backdrop-blur md:inset-6">
        <div className="flex min-h-0 flex-1">
          <VideoTile {...focusedTile} focused onClick={() => setFocusedId(null)} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-2 overflow-x-auto">
            {tiles.filter((t) => t.id !== focusedTile.id).map((t) => (
              <VideoTile key={t.id} {...t} onClick={() => setFocusedId(t.id)} />
            ))}
          </div>
          <button
            onClick={() => setFocusedId(null)}
            aria-label="Exit theater view"
            className="shrink-0 rounded-lg bg-base-600 p-2 text-signal hover:bg-base-500"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-30 flex max-w-[90vw] flex-wrap gap-2 rounded-xl bg-base-900/90 p-2 shadow-2xl backdrop-blur md:bottom-6 md:right-6">
      {tiles.map((t) => (
        <VideoTile key={t.id} {...t} onClick={() => setFocusedId(t.id)} />
      ))}
    </div>
  );
}
