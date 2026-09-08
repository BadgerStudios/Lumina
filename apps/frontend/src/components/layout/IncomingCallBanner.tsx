import { Phone, PhoneOff } from "lucide-react";
import { useVoiceStore } from "../../store/voiceStore";
import { UserAvatar } from "../common/UserAvatar";

/**
 * A floating banner for an incoming DM call, mounted once at the shell level (like VoiceDock) so it
 * shows wherever you are in the app. Accepting joins the call; declining tells the caller. Backed by
 * voiceStore.incomingCall, set from the CALL_INCOMING socket event in useSocketEvents.
 */
export function IncomingCallBanner() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const acceptCall = useVoiceStore((s) => s.acceptCall);
  const declineCall = useVoiceStore((s) => s.declineCall);
  if (!incomingCall) return null;

  const { from } = incomingCall;
  const name = from.displayName ?? from.username;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--safe-top)+0.75rem)] z-50 flex justify-center px-3">
      <div className="lx-raised pointer-events-auto flex items-center gap-3 rounded-2xl px-4 py-3">
        <UserAvatar avatarUrl={from.avatarUrl} name={name} size={40} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-signal">{name}</div>
          <div className="text-xs text-signal-faint">Incoming call…</div>
        </div>
        <button
          onClick={() => void acceptCall()}
          className="lx-focus ml-2 flex size-10 shrink-0 items-center justify-center rounded-full bg-online text-white transition hover:opacity-90"
          title="Accept call"
          aria-label="Accept call"
        >
          <Phone size={18} />
        </button>
        <button
          onClick={declineCall}
          className="lx-focus flex size-10 shrink-0 items-center justify-center rounded-full bg-flare text-white transition hover:opacity-90"
          title="Decline call"
          aria-label="Decline call"
        >
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  );
}
