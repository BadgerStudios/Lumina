import { useEffect, useRef } from "react";
import { X, Rocket } from "lucide-react";
import type { ActivityDTO } from "../../queries/game";
import { useAuthStore } from "../../store/authStore";

/**
 * The embedded-activity surface — a third-party app docked beside the channel.
 *
 * ## The trust boundary, spelled out
 *
 * The iframe is third-party code. Everything here is arranged around that fact:
 *
 *  - `sandbox` withholds top-level navigation and downloads. Scripts and its own origin's
 *    storage are allowed — an activity that can't run script or keep a session isn't an app.
 *  - The identity handshake is pushed with `postMessage(msg, ACTIVITY_ORIGIN)` — never "*". A
 *    targetOrigin of "*" would hand the user's identity to whatever page the frame happens to be
 *    on if it navigated itself somewhere else mid-session.
 *  - Inbound messages are checked against the same origin before being read at all.
 *  - What it gets is PUBLIC profile shape (id, username, display name, avatar) plus the room
 *    context. No token of any kind rides the handshake: an activity that wants API access has the
 *    documented OAuth2 flow, where the user consents on OUR page, not inside the frame.
 */
export function ActivityFrame({ activity, channelId, serverId, onClose }: {
  activity: ActivityDTO;
  channelId: string;
  serverId: string;
  onClose: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const origin = new URL(activity.url).origin;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== origin) return;
      if (e.data?.type === "lumina:ready" && frameRef.current?.contentWindow && user) {
        frameRef.current.contentWindow.postMessage(
          {
            type: "lumina:context",
            user: { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl },
            serverId,
            channelId,
            activityId: activity.id,
          },
          origin,
        );
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, user, serverId, channelId, activity.id]);

  return (
    <aside className="lx-pane flex w-full shrink-0 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 md:w-[28rem]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-base-700 px-3">
        <Rocket size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-signal">{activity.name}</span>
        <span className="shrink-0 truncate text-[11px] text-signal-faint">{origin}</span>
        <button onClick={onClose} className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal" title="Close activity">
          <X size={16} />
        </button>
      </header>
      <iframe
        ref={frameRef}
        src={activity.url}
        title={activity.name}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="autoplay; fullscreen"
        className="min-h-0 flex-1 border-0 bg-base-900"
      />
    </aside>
  );
}
