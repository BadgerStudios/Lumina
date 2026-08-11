import { useEffect, useRef } from "react";
import { useVoiceStore, getLocalVideoStream, getRemoteVideoStream } from "../../store/voiceStore";
import { useAuthStore } from "../../store/authStore";
import { cn } from "../../lib/cn";

function VideoTile({ label, stream, muted, speaking }: { label: string; stream: MediaStream; muted?: boolean; speaking?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return (
    <div className={cn("relative aspect-video w-48 shrink-0 overflow-hidden rounded-lg bg-base-900", speaking && "ring-2 ring-online")}>
      <video ref={videoRef} autoPlay playsInline muted={muted} className="h-full w-full object-cover" />
      <span className="absolute bottom-1 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">{label}</span>
    </div>
  );
}

/**
 * A floating overlay (not tied to whichever text channel/DM is currently open) rather than
 * something rendered inside ChatPane — voice connection state is global, independent of the
 * route you're viewing (you can be in a voice call while reading a completely different text
 * channel), so this is mounted once at the AppShell level like ModalRoot.
 */
export function VoiceVideoGrid() {
  const channelId = useVoiceStore((s) => s.channelId);
  const videoSource = useVoiceStore((s) => s.videoSource);
  const participants = useVoiceStore((s) => s.participants);
  const user = useAuthStore((s) => s.user);

  const remoteWithVideo = Object.values(participants).filter((p) => p.hasVideo);
  if (!channelId || (!videoSource && remoteWithVideo.length === 0)) return null;

  const localStream = videoSource ? getLocalVideoStream() : null;

  return (
    <div className="fixed bottom-4 right-4 z-30 flex max-w-[90vw] flex-wrap gap-2 rounded-xl bg-base-900/90 p-2 shadow-2xl backdrop-blur md:bottom-6 md:right-6">
      {localStream && user ? (
        <VideoTile label={`You${videoSource === "screen" ? " (screen)" : ""}`} stream={localStream} muted />
      ) : null}
      {remoteWithVideo.map((p) => {
        const stream = getRemoteVideoStream(p.socketId);
        if (!stream) return null;
        return <VideoTile key={p.socketId} label={p.user.displayName ?? p.user.username} stream={stream} speaking={p.speaking} />;
      })}
    </div>
  );
}
