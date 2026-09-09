// Build-time flag set via apps/frontend/.env.mobile / .env.desktop (VITE_CLIENT_TYPE) and
// `vite build --mode mobile` / `--mode desktop`. The plain web build never sets this, so it
// stays undefined and every non-web code path below is inert.
export const CLIENT_TYPE: "mobile" | "desktop" | undefined = import.meta.env.VITE_CLIENT_TYPE as
  | "mobile"
  | "desktop"
  | undefined;

/**
 * Which app this bundle is. Only the owner console sets it (apps/frontend/.env.owner).
 *
 * Distinct from CLIENT_TYPE, which answers "what is this running inside" — the owner console is
 * `CLIENT_TYPE === "mobile"` too, because it is the same Capacitor WebView with the same
 * no-cookie-jar consequences. What differs is which APK it *is*, and therefore which published
 * release its updater should compare itself against. Getting that wrong doesn't fail loudly: the
 * owner app would cheerfully download the chat APK, and Android would refuse to install it over
 * a different applicationId.
 */
export const APP_VARIANT: "owner" | undefined = import.meta.env.VITE_APP_VARIANT as "owner" | undefined;

// Capacitor's WebView (capacitor://localhost) and Electron's renderer (a custom app:// scheme,
// see apps/desktop) both load the app from an origin with no shared cookie jar with the API's
// https:// origin — same problem the web build doesn't have, same fix: the refresh token
// travels in the JSON body instead of an httpOnly cookie (see lib/mobileRefreshToken.ts, whose
// name predates desktop existing but whose Capacitor Preferences web-fallback storage works
// identically under Electron).
export const USES_BODY_REFRESH_TOKEN: boolean = CLIENT_TYPE === "mobile" || CLIENT_TYPE === "desktop";

/**
 * Where "go to the app" points.
 *
 * The web build serves a public landing page at `/` and hosts the app at `/app`; native builds have
 * no landing page and keep the app at `/`. Defined once because it was previously a hardcoded "/"
 * in nine places — each of which would silently become a trip through the marketing page the moment
 * the two diverged.
 */
export const APP_HOME: string = CLIENT_TYPE ? "/" : "/app";

/**
 * Where this app lives on the public web — the origin to put in a link you hand
 * to someone else.
 *
 * `window.location.origin` is the wrong answer everywhere except the browser: the
 * desktop app runs on `app://localhost` and the Capacitor apps on
 * `https://localhost`, so an invite copied from either was a dead link for
 * whoever received it. Native builds already carry an absolute
 * VITE_API_BASE_URL, so the public site is that URL's origin; on the web it is
 * simply where we already are.
 */
export const PUBLIC_ORIGIN: string = (() => {
  const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (apiBase && /^https?:\/\//i.test(apiBase)) {
    try {
      return new URL(apiBase).origin;
    } catch {
      // A malformed override: fall back to wherever the page actually is.
    }
  }
  return typeof window === "undefined" ? "" : window.location.origin;
})();
