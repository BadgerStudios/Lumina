import { api } from "./apiClient";
import { CLIENT_TYPE } from "./platform";

// Set when someone turns browser notifications off in Settings, so the repair below never
// quietly turns them back on.
const OPT_OUT_KEY = "lumina.push.webOptOut";

function setOptOut(on: boolean): void {
  try {
    if (on) localStorage.setItem(OPT_OUT_KEY, "1");
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    /* storage unavailable: nothing to remember with */
  }
}

function optedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

// Service worker + Push API aren't available in every environment this app runs in, so
// feature-detect rather than assuming: calling these on an unsupported client is then a silent
// no-op instead of a crash.
//
// The packaged Android app does not use this path at all any more. Its WebView never supported
// background Push delivery reliably, and it could never play anything but the system tone; it now
// registers with FCM instead (lib/nativePush.ts). Nothing should enable BOTH on one device — the
// server sends to each transport, so that device would be notified twice for every message.
export function isWebPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

let swRegistration: ServiceWorkerRegistration | null = null;

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;
  if (!swRegistration) {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
  }
  return swRegistration;
}

export async function getPushSubscriptionStatus(): Promise<"unsupported" | "denied" | "subscribed" | "unsubscribed"> {
  if (!isWebPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await getRegistration();
  const existing = await reg?.pushManager.getSubscription();
  return existing ? "subscribed" : "unsubscribed";
}

export async function subscribeToPush(): Promise<void> {
  const reg = await getRegistration();
  if (!reg) throw new Error("Push notifications aren't supported in this browser");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted");

  const { publicKey } = await api.get<{ publicKey: string | null }>("/push/vapid-public-key");
  if (!publicKey) throw new Error("Push notifications aren't configured on this server");

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = subscription.toJSON();
  await api.post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys });
  setOptOut(false);
}

/**
 * Keep this browser reachable, on every app start. The server forgets a subscription the push
 * service reports gone, and a browser can drop its own; either way notifications stopped with
 * nothing on screen to say so. With permission already granted this re-sends the subscription
 * (the server upserts it) or makes a new one, which needs no dialog. Browser tabs only, never
 * after someone switched notifications off in Settings, and it never throws.
 */
export async function ensureWebPushSubscription(): Promise<void> {
  try {
    if (CLIENT_TYPE || !isWebPushSupported() || Notification.permission !== "granted" || optedOut()) return;
    const reg = await getRegistration();
    const existing = await reg?.pushManager.getSubscription();
    if (existing) {
      const json = existing.toJSON();
      await api.post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys });
      return;
    }
    await subscribeToPush();
  } catch {
    // Offline, or the push service refused: the next start tries again.
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await getRegistration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  // Server first, then unsubscribe locally — not the other way around. Unsubscribing locally
  // first meant a failed /push/unsubscribe call (network blip, 500) left the server's row
  // pointing at a now-dead endpoint with no way to retry: a second call finds
  // pushManager.getSubscription() already null (the browser-side unsubscribe already took) and
  // early-returns above without ever retrying the server call. This way a failed server call
  // leaves the local subscription intact, so the user's next attempt can actually succeed.
  await api.post("/push/unsubscribe", { endpoint });
  await subscription.unsubscribe();
  setOptOut(true);
}
