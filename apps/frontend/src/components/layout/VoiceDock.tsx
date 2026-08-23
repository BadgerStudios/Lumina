import { Link } from "react-router-dom";
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react";
import { useVoiceStore } from "../../store/voiceStore";
import { useChannels } from "../../queries/channels";
import { useAuthStore } from "../../store/authStore";
import { SoundboardButton } from "../voice/SoundboardButton";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";

/**
 * The live-call dock.
 *
 * Voice used to be a strip wedged into the bottom of whichever left column happened to be showing,
 * with the mic and headphone buttons stranded in the user panel below it — permanently visible and
 * permanently disabled for the great majority of the time nobody is in a call. Being in a call is a
 * *global* state (you can be talking in one space while reading another), so it now surfaces as a
 * floating dock that exists only while it is true, mounted once at the shell level next to the
 * video grid it belongs with.
 *
 * Positioned bottom-centre over the content and above the mobile tab bar; `bottom-keyboard` keeps
 * it clear of the on-screen keyboard the same way the composer does.
 */
export function VoiceDock() {
  const serverId = useVoiceStore((s) => s.serverId);
  const channelId = useVoiceStore((s) => s.channelId);
  const connecting = useVoiceStore((s) => s.connecting);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const micMode = useVoiceStore((s) => s.micMode);
  const transmitting = useVoiceStore((s) => s.transmitting);
  const videoSource = useVoiceStore((s) => s.videoSource);
  const participants = useVoiceStore((s) => s.participants);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
  const leave = useVoiceStore((s) => s.leave);
  const user = useAuthStore((s) => s.user);
  const { data: channels } = useChannels(serverId ?? undefined);

  if (!channelId) return null;

  const channel = channels?.find((c) => c.id === channelId);
  const peers = Object.values(participants);
  /** In push-to-talk or voice-activity mode the gate, not the mute button, decides whether audio
   * is going out — so the button has to show the gate. A plain mic icon honestly reads as "you are
   * being heard", which is wrong most of the time in those modes. */
  const gatedMic = micMode !== "open";

  const btn =
    "lx-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal";

  return (
    <div
      className={cn(
        // z-30, deliberately below the modal scrim (z-40), the off-canvas sheets (z-40) and the tab
        // bar (z-50): the dock is ambient status, and floating it over a dialog someone is
        // answering is both ugly and a mis-tap waiting to happen.
        "pointer-events-none fixed inset-x-0 z-30 flex justify-center px-3",
        // Above the mobile tab bar on phones; a comfortable float above the composer elsewhere.
        "bottom-[calc(var(--bottom-nav-h)+env(safe-area-inset-bottom)+var(--keyboard-inset)+0.5rem)]",
        "md:bottom-[calc(var(--keyboard-inset)+1rem)]",
      )}
    >
      <div className="lx-dock pointer-events-auto flex max-w-full items-center gap-1 py-1.5 pl-3 pr-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connecting ? "bg-amber" : transmitting ? "bg-online" : "bg-signal-faint",
            )}
            style={transmitting ? { boxShadow: "0 0 0 3px color-mix(in srgb, var(--pulse) 25%, transparent)" } : undefined}
          />
          <span className="min-w-0">
            <span className="lx-eyebrow block leading-none">{connecting ? "Connecting" : "Live"}</span>
            {serverId && channel ? (
              <Link
                to={`/channels/${serverId}/${channel.id}`}
                className="block max-w-[9rem] truncate text-xs font-semibold text-signal hover:underline sm:max-w-[14rem]"
              >
                {channel.name}
              </Link>
            ) : (
              <span className="block max-w-[9rem] truncate text-xs font-semibold text-signal sm:max-w-[14rem]">
                Voice
              </span>
            )}
          </span>
        </span>

        {/* Who else is here. Capped at four faces plus a count — the dock is a status object, not
            a roster; the full list lives in the deck under the room. */}
        {peers.length > 0 && (
          <span className="ml-1 hidden items-center sm:flex">
            <span className="flex -space-x-1.5">
              {user && (
                <UserAvatar avatarUrl={user.avatarUrl} name={user.displayName ?? user.username} size={20} />
              )}
              {peers.slice(0, 3).map((p) => (
                <span key={p.socketId} className={cn("rounded-full", p.speaking && "ring-2 ring-online")}>
                  <UserAvatar avatarUrl={p.user.avatarUrl} name={p.user.displayName ?? p.user.username} size={20} />
                </span>
              ))}
            </span>
            {peers.length > 3 && (
              <span className="ml-1 font-mono text-[10px] text-signal-faint">+{peers.length - 3}</span>
            )}
          </span>
        )}

        <span className="mx-1 h-6 w-px shrink-0 bg-hairline" />

        <button
          onClick={toggleMute}
          className={cn(btn, muted ? "text-flare" : !muted && gatedMic && (transmitting ? "text-online" : "text-signal-faint"))}
          title={
            muted
              ? "Unmute"
              : gatedMic
                ? transmitting
                  ? "Transmitting"
                  : micMode === "ptt"
                    ? "Hold your push-to-talk key to speak"
                    : "Waiting for you to speak"
                : "Mute"
          }
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <button
          onClick={toggleDeafen}
          className={cn(btn, deafened && "text-flare")}
          title={deafened ? "Undeafen" : "Deafen"}
          aria-label={deafened ? "Undeafen" : "Deafen"}
        >
          {deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
        </button>
        <button
          onClick={() => void toggleCamera()}
          className={cn(btn, videoSource === "camera" && "text-online")}
          title={videoSource === "camera" ? "Turn off camera" : "Turn on camera"}
          aria-label="Toggle camera"
        >
          {videoSource === "camera" ? <Video size={16} /> : <VideoOff size={16} />}
        </button>
        <button
          onClick={() => void toggleScreenShare()}
          className={cn(btn, "hidden sm:flex", videoSource === "screen" && "text-online")}
          title={videoSource === "screen" ? "Stop screen share" : "Share your screen"}
          aria-label="Toggle screen share"
        >
          {videoSource === "screen" ? <ScreenShare size={16} /> : <ScreenShareOff size={16} />}
        </button>
        {serverId && (
          <span className="hidden sm:block">
            <SoundboardButton serverId={serverId} />
          </span>
        )}
        <button
          onClick={() => leave()}
          className="lx-focus flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-flare px-3 text-xs font-semibold text-white transition hover:opacity-90"
          title="Disconnect"
          aria-label="Disconnect"
        >
          <PhoneOff size={14} />
        </button>
      </div>
    </div>
  );
}
