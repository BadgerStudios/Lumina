import type { ChannelDTO, VoiceParticipantDTO } from "@lumina/shared";
import { Radio, Hand, Mic, MicOff, PhoneOff, ArrowUp, ArrowDown } from "lucide-react";
import { useVoiceStore } from "../../store/voiceStore";
import { useAuthStore } from "../../store/authStore";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";

/**
 * A stage channel: a moderated audio room where a few speakers present and everyone else listens.
 * Media reuses the voice mesh entirely (voiceStore) — this view only adds the speaker/audience
 * split, the raise-hand flow and the moderator promote/demote controls. Everyone joins as audience;
 * moderators (and anyone who could manage the channel) join as speakers.
 *
 * NOTE (v1): on a mesh the "audience is muted" rule is cooperative — an audience client simply
 * publishes no microphone track. True enforcement needs an SFU; see realtime/handlers/voice.ts.
 */
export function StageView({
  serverId,
  channel,
  canModerate,
}: {
  serverId: string;
  channel: ChannelDTO;
  canModerate: boolean;
}) {
  const myId = useAuthStore((s) => s.user?.id);
  const connectedChannelId = useVoiceStore((s) => s.channelId);
  const connecting = useVoiceStore((s) => s.connecting);
  const stageRole = useVoiceStore((s) => s.stageRole);
  const handRaised = useVoiceStore((s) => s.handRaised);
  const muted = useVoiceStore((s) => s.muted);
  const transmitting = useVoiceStore((s) => s.transmitting);
  const participants = useVoiceStore((s) => s.participants);
  const roster = useVoiceStore((s) => s.roster[channel.id]) ?? [];
  const join = useVoiceStore((s) => s.join);
  const leave = useVoiceStore((s) => s.leave);
  const raiseHand = useVoiceStore((s) => s.raiseHand);
  const setStageRole = useVoiceStore((s) => s.setStageRole);
  const toggleMute = useVoiceStore((s) => s.toggleMute);

  const connected = connectedChannelId === channel.id;
  const speakers = roster.filter((r) => r.stageRole === "speaker");
  const audience = roster.filter((r) => r.stageRole !== "speaker");
  const raisedCount = audience.filter((r) => r.handRaised).length;

  const isSpeaking = (r: VoiceParticipantDTO): boolean => {
    if (r.userId === myId) return transmitting;
    return Boolean(participants[r.socketId]?.speaking);
  };

  return (
    <div className="lx-pane relative flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-base-700 px-4">
        <Radio size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-signal">{channel.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-signal-faint">
          {speakers.length} on stage · {audience.length} listening
        </span>
      </header>
      {channel.topic && (
        <p className="shrink-0 border-b border-base-700 px-4 py-2 text-xs text-signal-faint">{channel.topic}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-2xl">
          <p className="lx-eyebrow mb-3">Speakers</p>
          {speakers.length === 0 ? (
            <p className="mb-6 text-sm text-signal-faint">No one is on stage yet.</p>
          ) : (
            <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-3">
              {speakers.map((r) => (
                <div key={r.socketId} className="flex flex-col items-center gap-1.5 text-center">
                  <span className={cn("rounded-full p-0.5 transition", isSpeaking(r) && "ring-2 ring-online")}>
                    <UserAvatar avatarUrl={r.user.avatarUrl} name={r.user.displayName ?? r.user.username} size={52} />
                  </span>
                  <span className="w-full truncate text-xs font-medium text-signal">
                    {r.user.displayName ?? r.user.username}
                  </span>
                  {canModerate && (
                    <button
                      onClick={() => setStageRole(r.socketId, "audience")}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-signal-faint hover:bg-base-700 hover:text-signal"
                      title="Move to audience"
                    >
                      <ArrowDown size={10} /> Move down
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="lx-eyebrow mb-3 flex items-center gap-2">
            Audience
            {raisedCount > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                <Hand size={10} /> {raisedCount} raised
              </span>
            )}
          </p>
          {audience.length === 0 ? (
            <p className="text-sm text-signal-faint">No listeners yet.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-3">
              {audience.map((r) => (
                <div key={r.socketId} className="flex flex-col items-center gap-1 text-center">
                  <span className="relative">
                    <UserAvatar avatarUrl={r.user.avatarUrl} name={r.user.displayName ?? r.user.username} size={40} />
                    {r.handRaised && (
                      <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-accent text-white">
                        <Hand size={9} />
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-[11px] text-signal-dim">
                    {r.user.displayName ?? r.user.username}
                  </span>
                  {canModerate && r.handRaised && (
                    <button
                      onClick={() => setStageRole(r.socketId, "speaker")}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
                      title="Invite to speak"
                    >
                      <ArrowUp size={10} /> Invite
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-base-700 p-3">
        {!connected ? (
          <button
            onClick={() => void join(serverId, channel.id, { stage: true })}
            disabled={connecting}
            className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            <Radio size={16} /> {connecting ? "Joining…" : "Join stage"}
          </button>
        ) : (
          <>
            {stageRole === "speaker" ? (
              <button
                onClick={toggleMute}
                className={cn(
                  "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition",
                  muted ? "bg-base-700 text-signal-dim hover:text-signal" : "bg-online/15 text-online",
                )}
                title={muted ? "Unmute" : "Mute"}
              >
                {muted ? <MicOff size={15} /> : <Mic size={15} />}
                {muted ? "Muted" : "Speaking"}
              </button>
            ) : (
              <button
                onClick={() => raiseHand(!handRaised)}
                className={cn(
                  "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition",
                  handRaised ? "bg-accent/20 text-accent" : "bg-base-700 text-signal-dim hover:text-signal",
                )}
                title={handRaised ? "Lower your hand" : "Raise your hand to speak"}
              >
                <Hand size={15} /> {handRaised ? "Hand raised" : "Raise hand"}
              </button>
            )}
            <button
              onClick={() => leave()}
              className="flex items-center gap-2 rounded-full bg-flare px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              title="Leave stage"
            >
              <PhoneOff size={15} /> Leave
            </button>
          </>
        )}
      </div>
    </div>
  );
}
