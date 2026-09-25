import { ServerEvents } from "@lumina/shared";
import { getSocket } from "../socket/socketClient";
import { CLIENT_TYPE } from "./platform";

/** What the server sends alongside a push: the same words the phone would show. */
interface NotifyEvent {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/**
 * Operating-system notifications in the desktop app, while its window is not in front.
 *
 * ## The gap this closes
 *
 * The desktop app is Electron, and Electron has no push service: web push can never reach it. So
 * a DM or a mention that arrived while the app sat minimised showed nothing at all — a sound for a
 * DM, if sounds were on, and no mention of anything else. Only an incoming call raised a
 * notification (IncomingCallBanner).
 *
 * ## Why the server decides, not this file
 *
 * Whether something deserves a notification is already worked out in one place, the server's
 * sendPushToUser: mutes, the person's per-kind switches, mention and reply rules, channel
 * notification levels, cooldowns. Re-deriving that here would drift. So wherever the server pushes
 * to phones it also sends ServerEvents.NOTIFY to the person's open sockets, and the desktop app
 * shows it. That also means the server's "active on a desktop" rule applies: a window in front
 * gets nothing, because the person is looking at it.
 *
 * Phones and browser tabs ignore the event: the phone is notified by FCM, a browser by web push.
 */
export function attachDesktopNotifications(onOpen: (url: string) => void): () => void {
  if (CLIENT_TYPE !== "desktop" || typeof Notification === "undefined") return () => {};

  const show = (e: NotifyEvent) => {
    try {
      const n = new Notification(e.title, { body: e.body, tag: e.tag, icon: "/icons/pwa-192.png" });
      n.onclick = () => {
        window.focus();
        if (typeof e.url === "string" && e.url.startsWith("/")) onOpen(e.url);
        n.close();
      };
    } catch {
      // Some embedded shells refuse to construct notifications; there is nothing else to try.
    }
  };

  const onNotify = (e: NotifyEvent) => {
    if (!e || typeof e.title !== "string") return;
    // Looking at the app: the message is already on screen, a notification over it is noise.
    if (!document.hidden && document.hasFocus()) return;
    if (Notification.permission === "granted") show(e);
    else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") show(e);
      });
    }
  };

  const socket = getSocket();
  socket.on(ServerEvents.NOTIFY, onNotify);
  return () => {
    socket.off(ServerEvents.NOTIFY, onNotify);
  };
}
