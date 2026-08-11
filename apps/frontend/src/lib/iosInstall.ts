/**
 * Detecting whether this is an iPhone/iPad that has not yet installed Lumina to the Home Screen.
 *
 * ## Why this matters more on iOS than anywhere else
 *
 * On Android, Chrome fires `beforeinstallprompt` and the browser offers installation by itself.
 * **Safari fires nothing and offers nothing.** The only route is Share → Add to Home Screen, and
 * there is no API to trigger it, no event to listen for, and no way to know whether the user has
 * already done it other than checking whether *this* window is running standalone.
 *
 * That gap has a real consequence beyond a missing icon: since iOS 16.4, a home-screen web app is
 * the **only** way an iPhone can receive Web Push. In a Safari tab `window.Notification` does not
 * exist at all, so the app's notification settings correctly report "unsupported" and the user has
 * no way to discover that installing changes the answer. Without a prompt, push on iOS is a feature
 * that exists and that nobody ever reaches.
 */

/**
 * iOS, including iPadOS.
 *
 * iPadOS 13+ reports a desktop Safari user agent — "Macintosh; Intel Mac OS X" — specifically so
 * sites serve it the desktop layout, which makes a naive /iPad/ test fail on every modern iPad. The
 * touch-points check is the standard discriminator: a real Mac reports maxTouchPoints 0.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/iPad/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Safari specifically. Chrome and Firefox on iOS are Safari underneath, but they cannot install to
 * the Home Screen at all — so telling their users to do it would be advice they cannot follow. */
export function isIOSSafari(): boolean {
  if (!isIOS()) return false;
  const ua = navigator.userAgent;
  // CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge, OPiOS/OPT = Opera.
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua);
}

/**
 * Whether the app is running as an installed home-screen app rather than in a browser tab.
 *
 * Two checks because the platforms disagree: `display-mode: standalone` is the standard, and
 * `navigator.standalone` is Apple's own non-standard property that predates it and is still the
 * reliable signal on iOS.
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** Show the "Add to Home Screen" hint: an iPhone/iPad, in Safari, not already installed. */
export function shouldOfferIOSInstall(): boolean {
  return isIOSSafari() && !isStandalone();
}

/**
 * Whether push is unavailable *only because* the app isn't installed.
 *
 * Distinguishes "your browser can't do this" from "your browser can do this once you install",
 * which are the same message today and shouldn't be — the second one has a fix the user can act on.
 */
export function pushNeedsInstallOnIOS(): boolean {
  return isIOS() && !isStandalone() && !("PushManager" in window);
}
