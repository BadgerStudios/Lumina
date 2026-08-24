import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { CLIENT_TYPE } from "../../lib/platform";

/**
 * Turns an Android App Link into in-app navigation.
 *
 * The password-reset email links to https://lumina.badgerstudios.net/reset-password?token=… — on
 * a phone with the app installed, Android hands that URL to the APP (see the autoVerify
 * intent-filter in apps/mobile/android/app/src/main/AndroidManifest.xml), not the browser. But a
 * Capacitor WebView loads its bundle from https://localhost, so nothing navigates by itself: the
 * app opens on whatever screen it was on and the tapped link is silently dropped. That was the
 * reset-flow bug — the email arrived, the app opened, and the "choose a new password" form never
 * appeared. This listener is the missing half: it receives the URL and routes to it in-app.
 *
 * Kept deliberately narrow:
 * - Hosts are allowlisted to our own origins, mirroring the manifest's <data android:host> entries.
 *   The OS filter already guarantees this for real App Links, but any app can fire an explicit
 *   VIEW intent at us with an arbitrary URL — cheap to not trust it.
 * - Paths mirror the manifest's claims (reset/verify/invite). Everything else is ignored rather
 *   than navigated, so a stray link can never teleport someone out of a call into a random route.
 *
 * Minimal inline surface of @capacitor/app rather than an import from it: the WEB build must not
 * grow a dependency for a native-only event, and registerPlugin resolves the same native plugin
 * the package would. Every call is wrapped: on an older installed APK that predates the plugin
 * (bundle newer than binary), addListener rejects and the app behaves exactly as before.
 */
interface AppPlugin {
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { url: string }) => void,
  ): Promise<PluginListenerHandle>;
  getLaunchUrl(): Promise<{ url: string } | null | undefined>;
}

const CapacitorApp = registerPlugin<AppPlugin>("App");

const ALLOWED_HOSTS = new Set(["lumina.badgerstudios.net", "lumina.luxffa.com"]);

/** Keep in sync with the intent-filter paths in apps/mobile AndroidManifest.xml. */
const ALLOWED_PATHS = [/^\/reset-password$/, /^\/verify-email$/, /^\/invite\/[^/]+$/];

function toInternalPath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
  if (!ALLOWED_PATHS.some((p) => p.test(url.pathname))) return null;
  // Query string rides along — for /reset-password it IS the payload (?token=…).
  return url.pathname + url.search;
}

export function DeepLinkHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    if (CLIENT_TYPE !== "mobile") return;

    let cancelled = false;
    let handle: PluginListenerHandle | null = null;

    void (async () => {
      // Warm start: the app was already running (launchMode singleTask routes the intent to the
      // existing instance) and the URL arrives as an event.
      try {
        handle = await CapacitorApp.addListener("appUrlOpen", ({ url }) => {
          const path = toInternalPath(url);
          if (path) navigate(path);
        });
      } catch {
        /* plugin not in this APK — an old binary running a new bundle; deep links just stay off */
      }
      // Cold start: the tap launched the app, so the URL predates the listener above and is only
      // available by asking. `replace` so Back leaves the app instead of landing on the home
      // screen the user never actually saw.
      try {
        const launch = await CapacitorApp.getLaunchUrl();
        if (!cancelled && launch?.url) {
          const path = toInternalPath(launch.url);
          if (path) navigate(path, { replace: true });
        }
      } catch {
        /* same as above */
      }
    })();

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [navigate]);

  return null;
}
