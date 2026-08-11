import { useEffect } from "react";
import { ClientEvents } from "@lumina/shared";
import { getSocket } from "./socketClient";

/** Joins `channel:{channelId}` on mount / channelId change, leaves on unmount — this is what
 * makes the socket actually receive message:create/update/delete + reaction + typing events
 * for the channel currently being viewed (see realtime/handlers/channelRoom.ts server-side). */
export function useChannelRoom(channelId: string | undefined): void {
  useEffect(() => {
    if (!channelId) return;
    const socket = getSocket();
    let cancelled = false;

    const join = () => {
      socket.emit(ClientEvents.CHANNEL_JOIN, { channelId }, (res: { ok: boolean; error?: string }) => {
        if (!res?.ok && !cancelled) {
          // eslint-disable-next-line no-console
          console.warn("Failed to join channel room", channelId, res?.error);
        }
      });
    };

    if (socket.connected) join();
    socket.on("connect", join);

    return () => {
      cancelled = true;
      socket.off("connect", join);
      socket.emit(ClientEvents.CHANNEL_LEAVE, { channelId });
    };
  }, [channelId]);
}
