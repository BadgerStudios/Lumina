import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Music } from "lucide-react";
import { ClientEvents, ServerEvents } from "@lumina/shared";
import { getSocket } from "../../socket/socketClient";
import { useSounds } from "../../queries/expressions";
import { resolveAssetUrl } from "../../lib/apiClient";
import { useVoiceStore } from "../../store/voiceStore";

interface PlayPayload {
  channelId: string;
  userId: string;
  soundId: string;
  name: string;
  audioUrl: string;
}

/**
 * The soundboard, shown only while connected to a voice channel.
 *
 * Pressing a button emits a *request*; nothing plays locally until the server relays it back. That
 * round trip is deliberate — it is what makes everyone in the channel start the clip from the same
 * event, and it means a press that the server refuses (not actually in the channel, sound from
 * another server, rate limited) plays nothing rather than playing for the presser alone and no one
 * else, which is the confusing failure.
 */
export function SoundboardButton({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const deafened = useVoiceStore((s) => s.deafened);
  const { data: sounds } = useSounds(open ? serverId : undefined);
  // Kept in a ref rather than state: the play handler must see the current value without the
  // listener being torn down and re-attached every time someone toggles deafen.
  const deafenedRef = useRef(deafened);
  deafenedRef.current = deafened;

  useEffect(() => {
    const socket = getSocket();
    const onPlay = (payload: PlayPayload) => {
      // Deafened means hearing nothing from this channel. A soundboard clip that ignored that
      // would be the one sound in the app that can reach someone who explicitly asked for silence.
      if (deafenedRef.current) return;
      const audio = new Audio(resolveAssetUrl(payload.audioUrl));
      audio.volume = 0.7;
      // Autoplay policy blocks this if the tab has never been interacted with. Nothing to do about
      // it and nothing worth surfacing — a clip that did not play is not an error state.
      void audio.play().catch(() => undefined);
    };
    socket.on(ServerEvents.SOUNDBOARD_PLAY, onPlay);
    return () => {
      socket.off(ServerEvents.SOUNDBOARD_PLAY, onPlay);
    };
  }, []);

  if (!voiceChannelId) return null;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="shrink-0 text-signal-dim hover:text-signal" title="Soundboard" aria-label="Soundboard">
          <Music size={15} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border border-base-500 bg-base-700 p-2 shadow-lg"
        >
          {!sounds ? (
            <p className="p-3 text-center text-xs text-signal-faint">Loading…</p>
          ) : sounds.length === 0 ? (
            <p className="p-3 text-center text-xs text-signal-faint">
              No sounds here yet. Someone with Manage Emoji can add them in server settings.
            </p>
          ) : (
            <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto">
              {sounds.map((sound) => (
                <DropdownMenu.Item
                  key={sound.id}
                  onSelect={(e) => {
                    // Keeps the panel open: soundboards are used in bursts, and closing after every
                    // press would make a two-clip joke take four interactions.
                    e.preventDefault();
                    getSocket().emit(ClientEvents.SOUNDBOARD_PLAY, { soundId: sound.id });
                  }}
                  className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-xs text-signal outline-none hover:bg-base-600"
                >
                  {sound.emoji ? <span aria-hidden>{sound.emoji}</span> : <Music size={12} className="text-signal-faint" />}
                  <span className="min-w-0 flex-1 truncate">{sound.name}</span>
                </DropdownMenu.Item>
              ))}
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
