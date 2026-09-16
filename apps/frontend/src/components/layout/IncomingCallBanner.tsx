import { useEffect } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { useVoiceStore } from "../../store/voiceStore";
import { UserAvatar } from "../common/UserAvatar";
import { startRingtone, stopRingtone } from "../../lib/ringtone";

/**
 * A floating banner for an incoming DM call, mounted once at the shell level (like VoiceDock) so it
 * shows wherever you are in the app. Accepting joins the call; declining tells the caller. Backed by
 * voiceStore.incomingCall, set from the CALL_INCOMING socket event in useSocketEvents.
 *
 * A call is easy to miss as a silent visual banner, so while one is ringing this also plays a
 * looping ringtone and — if the tab is hidden and notifications are granted — raises an OS
 * notification. All of it stops the moment the call is answered, declined, or ends.
 */
const RING_TIMEOUT_MS = 60_000;

export function IncomingCallBanner() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const acceptCall = useVoiceStore((s) => s.acceptCall);
  const declineCall = useVoiceStore((s) => s.declineCall);

  const conversationId = incomingCall?.conversationId;
  const callerName = incomingCall ? (incomingCall.from.displayName ?? incomingCall.from.username) : null;

  useEffect(() => {
    if (!conversationId) return;
    startRingtone();
    // A phone stops ringing after a while; so does this. The caller may still be waiting in the call,
    // and the conversation's call button still joins them.
    const giveUp = window.setTimeout(() => {
      if (useVoiceStore.getState().incomingCall?.conversationId === conversationId) useVoiceStore.getState().setIncomingCall(null);
    }, RING_TIMEOUT_MS);
    let notif: Notification | null = null;
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        notif = new Notification(`${callerName} is calling…`, {
          body: "Tap to answer",
          tag: `call-${conversationId}`,
        });
        notif.onclick = () => window.focus();
      }
    } catch {
      // Notification construction can throw in some embedded WebViews — the banner still shows.
    }
    return () => {
      window.clearTimeout(giveUp);
      stopRingtone();
      try {
        notif?.close();
      } catch {
        /* ignore */
      }
    };
  }, [conversationId, callerName]);

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
