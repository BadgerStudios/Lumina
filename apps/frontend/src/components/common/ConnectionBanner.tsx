import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { getSocket } from "../../socket/socketClient";
import { ICON } from "./Icon";

/**
 * A slim "Reconnecting…" bar shown whenever the realtime socket drops after it had connected.
 *
 * socket.io-client reconnects on its own (see socket/socketClient.ts) — this only makes that
 * invisible retry visible, so a stalled presence/message stream reads as "the app is catching up"
 * rather than "the app is broken". It never appears during the initial pre-connect gap: that would
 * flash on every cold load and on the sign-in screens, so the bar is gated on having seen at least
 * one successful connection first. Subscribes to the raw client `connect`/`disconnect` events the
 * same way useChannelRoom does, rather than adding another store.
 */
export function ConnectionBanner() {
  const [connected, setConnected] = useState(() => getSocket().connected);
  const [everConnected, setEverConnected] = useState(() => getSocket().connected);

  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => {
      setConnected(true);
      setEverConnected(true);
    };
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    // Reconcile against any transition that landed between the initial render and this effect —
    // the socket may have connected (or dropped) in that window, and we'd otherwise miss the edge.
    setConnected(socket.connected);
    if (socket.connected) setEverConnected(true);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  if (connected || !everConnected) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[65] flex justify-center px-4"
      style={{ paddingTop: "calc(var(--safe-top) + 0.5rem)" }}
      role="status"
      aria-live="polite"
    >
      <div className="lm-toast pointer-events-auto flex items-center gap-2 rounded-full border border-hairline bg-base-800 px-3 py-1.5 text-meta font-semibold text-signal-dim shadow-lg">
        <Loader2 size={ICON.xs} className="shrink-0 animate-spin text-accent" />
        Reconnecting…
      </div>
    </div>
  );
}
