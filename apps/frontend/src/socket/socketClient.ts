import { io, type Socket } from "socket.io-client";
import { useAuthStore } from "../store/authStore";

// Web build connects same-origin (relative "/", proxied by Vite dev / nginx in prod). The
// mobile (Capacitor) build has no such same-origin proxy to ride along with, so it points at
// the absolute public URL instead — see apps/frontend/.env.mobile.
const SOCKET_URL: string = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? "/";

let socket: Socket | null = null;

/**
 * Singleton socket.io-client instance. `auth` is a function re-evaluated on every
 * (re)connection attempt, so if the access token is refreshed while disconnected/erroring,
 * the client's built-in reconnection backoff will pick up the fresh token on its next
 * automatic retry with no extra wiring needed.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      path: "/socket.io",
      autoConnect: false,
      auth: (cb) => cb({ accessToken: useAuthStore.getState().accessToken }),
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function connectSocket(): void {
  const s = getSocket();
  if (!s.connected && !s.active) s.connect();
}

export function disconnectSocket(): void {
  socket?.disconnect();
}

/**
 * Force a real disconnect+reconnect — used after creating/joining a server or DM so the
 * backend's `joinInitialRooms()` (realtime/io.ts) re-runs and picks up the new `server:*`/
 * `dm:*` room from current DB state; those rooms are ONLY computed at connect time, so without
 * this the socket silently never receives further broadcasts (member joins, channel/role
 * changes, messages from others) for whatever was just created until the page happens to reload.
 *
 * Deliberately unconditional — an earlier version only reconnected `if (!s.connected)`, which
 * made it a complete no-op for the actual call site (queries/dms.ts's useCreateDM, called right
 * after a successful mutation, when the socket is essentially always still connected). That bug
 * was invisible in scripts/verify-realtime.mjs because that test manually disconnects+reconnects
 * the raw socket directly rather than calling this helper, so it never actually exercised the
 * frontend's real code path — a good example of why "the pure logic is unit-tested" isn't the
 * same as "the live app was verified using a real browser end-to-end".
 */
export function reconnectSocket(): void {
  const s = getSocket();
  s.disconnect();
  s.connect();
}
