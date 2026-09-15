import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { api } from "./apiClient";
import { toast } from "../store/toastStore";
import { CLIENT_TYPE } from "./platform";

/**
 * Notifications the phone renders itself, through Firebase Cloud Messaging.
 *
 * ## Why this exists next to webPush.ts
 *
 * Web push reaches the Capacitor WebView, but it always plays the system notification tone: Chrome
 * dropped `Notification.sound`, and there is no way to ask for anything else. A sound belongs to an
 * Android notification channel, and only an FCM message can name a channel. So the app's own tone,
 * icon and colour are only reachable this way.
 *
 * ## Exactly one transport per device
 *
 * The server sends to both (see backend lib/push.ts), so a phone holding an FCM token AND a
 * web-push subscription would be notified twice for every message. The settings UI therefore treats
 * these as one switch with two implementations, and picks this one wherever it works.
 *
 * ## Talking to the plugin without depending on it
 *
 * Addressed through `registerPlugin` rather than importing `@capacitor/push-notifications`, the same
 * way ageSignals.ts reaches its plugin. This bundle is also the web and desktop build, and neither
 * should carry a Firebase-flavoured dependency to call something that isn't there. It also means an
 * older installed APK running a newer web bundle degrades to "unsupported" rather than crashing.
 */

type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";

/** What Android hands back for a delivered notification. Every field is optional: a data-only
 * message carries no title or body at all. */
interface PushPayload {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

interface PushNotificationsShape {
  checkPermissions(): Promise<{ receive: PermissionState }>;
  requestPermissions(): Promise<{ receive: PermissionState }>;
  register(): Promise<void>;
  addListener(event: "registration", cb: (token: { value: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "registrationError", cb: (err: { error: string }) => void): Promise<PluginListenerHandle>;
  /** Delivered to the app INSTEAD of being drawn, whenever the app is in the foreground. */
  addListener(
    event: "pushNotificationReceived",
    cb: (notification: PushPayload) => void,
  ): Promise<PluginListenerHandle>;
  /** The app was opened by tapping a notification. */
  addListener(
    event: "pushNotificationActionPerformed",
    cb: (action: { notification: PushPayload }) => void,
  ): Promise<PluginListenerHandle>;
}

const PushNotifications = registerPlugin<PushNotificationsShape>("PushNotifications");

/**
 * The token this device last registered.
 *
 * Kept only so unregistering knows what to delete — the server's row is keyed by the token itself.
 * Losing it (cleared site data, reinstall) costs nothing permanent: the token is reassigned the next
 * time this device registers, and a genuinely dead one is pruned server-side when a send to it fails.
 */
const TOKEN_KEY = "lumina.nativePushToken";

function rememberedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function rememberToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode or blocked storage: registration still works, only the local record is lost.
  }
}

/** Android only. iOS is browser/PWA here, and the web and desktop builds have no plugin at all. */
export function isNativePushSupported(): boolean {
  return (
    CLIENT_TYPE === "mobile" &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("PushNotifications")
  );
}

/**
 * Ask the plugin for a token.
 *
 * `register()` returns before the token exists — it arrives on the `registration` event — so both
 * listeners are attached BEFORE registering. Attaching them afterwards is a race the device
 * sometimes wins, and losing it means hanging until the timeout for no reason.
 *
 * The timeout matters because a missing google-services.json produces neither event: Firebase never
 * initialises, and without it this would wait forever behind a spinner.
 */
async function requestToken(timeoutMs = 20_000): Promise<string> {
  let resolveToken!: (token: string) => void;
  let rejectToken!: (err: Error) => void;
  const token = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const handles: PluginListenerHandle[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    handles.push(await PushNotifications.addListener("registration", (t) => resolveToken(t.value)));
    handles.push(
      await PushNotifications.addListener("registrationError", (e) =>
        rejectToken(new Error(e.error || "This device could not be registered for notifications")),
      ),
    );
    await PushNotifications.register();
    return await Promise.race([
      token,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Registering this device for notifications timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.all(handles.map((h) => h.remove().catch(() => {})));
  }
}

export type NativePushStatus = "unsupported" | "denied" | "subscribed" | "unsubscribed";

export async function getNativePushStatus(): Promise<NativePushStatus> {
  if (!isNativePushSupported()) return "unsupported";
  try {
    const { receive } = await PushNotifications.checkPermissions();
    if (receive === "denied") return "denied";
    // Permission alone isn't enough to call it on: Android 12 and earlier grant it implicitly, so
    // every such device would claim to be subscribed before it had ever registered.
    return receive === "granted" && rememberedToken() ? "subscribed" : "unsubscribed";
  } catch {
    return "unsupported";
  }
}

export async function enableNativePush(): Promise<void> {
  if (!isNativePushSupported()) throw new Error("Native notifications aren't available on this device");

  let { receive } = await PushNotifications.checkPermissions();
  if (receive !== "granted") ({ receive } = await PushNotifications.requestPermissions());
  if (receive !== "granted") throw new Error("Notification permission was not granted");

  const token = await requestToken();
  await api.post("/push/device", { token, platform: "android" });
  rememberToken(token);
}

export async function disableNativePush(): Promise<void> {
  const token = rememberedToken();
  if (!token) return;
  // Server first, then forget it locally — the same ordering as unsubscribeFromPush, and for the
  // same reason: forgetting first would leave a failed call with no token to retry with, and the
  // device would keep being notified with no way left to turn it off.
  await api.delete("/push/device", { token, platform: "android" });
  rememberToken(null);
}

/**
 * React to a notification arriving, and to one being tapped.
 *
 * ## The foreground hole this closes
 *
 * Android does not draw a notification while the app that owns it is in the foreground. It hands
 * the message to the app instead and expects the app to decide — which is correct, because a
 * system notification for the screen you are already looking at is noise. But an app that attaches
 * no listener does not get a choice: the message is delivered to nothing and disappears.
 *
 * That made the self-test in settings impossible to pass. Tapping "Send a test" guarantees the app
 * is in the foreground, so the one notification a person deliberately asked for was the one
 * notification Android would never draw. It looked exactly like a broken push pipeline, and it was
 * a missing four-line listener.
 *
 * In-app, a toast is the right surface anyway. Someone looking at the app does not need the
 * notification shade pulled over it.
 *
 * ## And the tap
 *
 * Every push carries a `url` — that is the whole point of a notification about a specific thing.
 * On the web the service worker acts on it (public/sw.js, notificationclick). The native apps had
 * no equivalent, so a tap opened the app at whatever screen it was last on and the deep link was
 * discarded. `onOpen` is optional because the owner console navigates by internal state rather
 * than by URL and has nothing sensible to do with a path.
 *
 * Returns a cleanup that detaches both listeners.
 */
export function attachNativePushHandlers(onOpen?: (url: string) => void): () => void {
  if (!isNativePushSupported()) return () => {};

  const pending: Promise<PluginListenerHandle>[] = [
    PushNotifications.addListener("pushNotificationReceived", (n) => {
      // title and body are what the server already decided is safe to show on a lock screen, so
      // they are safe here. Either can be absent on a data-only message.
      const text = [n.title, n.body].filter(Boolean).join(" — ");
      if (text) toast.success(text);
    }),
    PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const url = action.notification?.data?.url;
      if (typeof url === "string" && url.startsWith("/")) onOpen?.(url);
    }),
  ];

  return () => {
    void Promise.all(pending).then((handles) =>
      Promise.all(handles.map((h) => h.remove().catch(() => {}))),
    );
  };
}

/**
 * Keep an already-enabled device registered, quietly.
 *
 * FCM rotates tokens on its own schedule — a restore to a new device, an app-data clear, a Google
 * Play Services update — and a rotated token is simply dead. Re-registering at startup is what keeps
 * notifications working past that, and since the row is upserted on the token it is also what moves
 * a device to whoever is signed in now.
 *
 * Never prompts, and never throws: this runs on startup where there is nobody to show an error to.
 */
export async function syncNativePushRegistration(): Promise<void> {
  if (!isNativePushSupported()) return;
  try {
    const { receive } = await PushNotifications.checkPermissions();
    if (receive !== "granted" || !rememberedToken()) return;
    const token = await requestToken();
    await api.post("/push/device", { token, platform: "android" });
    rememberToken(token);
  } catch {
    // An expired session, no network, Firebase not configured — all of them are things the next
    // startup can retry. Nothing here is worth interrupting the app for.
  }
}
