import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X, Loader2 } from "lucide-react";
import { useAndroidUpdate, useWebUpdateAvailable } from "../../queries/meta";
import { CLIENT_TYPE } from "../../lib/platform";
import { AppUpdater, PERMISSION_REQUIRED, CHECKSUM_MISMATCH } from "../../lib/appUpdater";
import { toast } from "../../store/toastStore";

const DISMISS_KEY = "lumina_update_dismissed_at";
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * "You're running an old build" — one banner, three completely different mechanisms behind it.
 *
 * - **Android**: the APK is sideloaded, so there is no store to do this. Tapping Update downloads
 *   the published APK in-app (with progress), checks it against the digest the API published, and
 *   opens the system installer. Android will not let any normal app install silently, so the final
 *   confirmation is the user's — the win is one tap instead of a trip through the browser, the
 *   notification tray and a file manager.
 * - **Web**: nothing to install; the tab is simply running JavaScript from a previous deploy.
 *   Reloading is the whole update.
 * - **Desktop**: absent by design. electron-updater downloads and swaps the AppImage from the main
 *   process (apps/desktop/src/updater.ts) and prompts there, so a second banner in the renderer
 *   would be a duplicate of a thing already handled.
 */
export function UpdateBanner() {
  const android = useAndroidUpdate();
  const webStale = useWebUpdateAvailable();
  const [dismissed, setDismissed] = useState(() => {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_TTL_MS;
  });

  const [progress, setProgress] = useState<number | null>(null);
  const listener = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    return () => {
      listener.current?.remove();
    };
  }, []);

  // A Google Play build must never offer to update itself: Play's Device and Network Abuse
  // policy reserves updating to Play's own mechanism, and the Play flavor strips both the
  // AppUpdater plugin and REQUEST_INSTALL_PACKAGES. The flag is set by MainActivity before the
  // web layer renders. Play delivers app updates; the web-stale prompt is equally pointless
  // there, since the assets are bundled in the APK rather than fetched.
  if (typeof window !== "undefined" && (window as unknown as { __LUMINA_PLAY_BUILD__?: boolean }).__LUMINA_PLAY_BUILD__) {
    return null;
  }

  const available = android.available || webStale;
  if (!available || dismissed) return null;

  const startAndroidUpdate = async () => {
    if (!android.release) return;
    setProgress(0);
    try {
      const handle = await AppUpdater.addListener("downloadProgress", ({ loaded, total }) => {
        setProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
      });
      listener.current = handle;
      await AppUpdater.downloadAndInstall({ url: android.release.url, sha256: android.release.sha256 });
      // The system installer is now in front of the user; the banner stays put so that backing out
      // of it doesn't leave them with no way back in.
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes(PERMISSION_REQUIRED)) {
        toast.error("Android needs permission to install updates — turn on “Allow from this source”, then tap Update again");
        void AppUpdater.openInstallSettings();
      } else if (message.includes(CHECKSUM_MISMATCH)) {
        // Never offer to install it anyway. A download that doesn't match the published digest is
        // the one case where doing nothing is unambiguously correct.
        toast.error("The downloaded update didn't match its signature and was discarded");
      } else {
        // The native downloader failed for a reason the plugin now names (UnknownHostException,
        // SocketTimeoutException, ActivityNotFoundException…). Say it, then hand the SAME URL to
        // the system browser: Chrome downloads the APK and the user taps it to install — a path
        // that works even when the in-app HttpURLConnection cannot, so an updater failure never
        // leaves someone stranded on an old build.
        toast.error(`In-app download failed (${message}). Opening the update in your browser instead.`);
        if (android.release) window.open(android.release.url, "_blank");
      }
    } finally {
      listener.current?.remove();
      listener.current = null;
      setProgress(null);
    }
  };

  const downloading = progress !== null;

  return (
    <div className="relative flex items-center gap-2 overflow-hidden bg-accent px-3 py-2 text-sm font-medium text-white">
      {downloading && (
        <div
          className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-200"
          style={{ width: `${progress}%` }}
          aria-hidden="true"
        />
      )}
      <div className="relative flex min-w-0 flex-1 items-center gap-2">
        {CLIENT_TYPE === "mobile" ? (
          <Download size={16} className="shrink-0" />
        ) : (
          <RefreshCw size={16} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {downloading
            ? `Downloading update... ${progress}%`
            : CLIENT_TYPE === "mobile"
              ? "A new version of Lumina is available."
              : "Lumina has been updated. Reload to get the new version."}
        </span>
      </div>

      {CLIENT_TYPE === "mobile" ? (
        <button
          type="button"
          onClick={() => void startAndroidUpdate()}
          disabled={downloading || !android.release}
          className="relative flex shrink-0 items-center gap-1 rounded bg-white/20 px-2 py-1 text-xs font-semibold hover:bg-white/30 disabled:opacity-60"
        >
          {downloading && <Loader2 size={12} className="animate-spin" />}
          {downloading ? "Installing" : "Update"}
        </button>
      ) : (
        <button
          type="button"
          // Bypasses the bfcache/memory cache so the new index.html and its new entry chunk are
          // actually fetched rather than the stale pair being restored.
          onClick={() => window.location.reload()}
          className="relative shrink-0 rounded bg-white/20 px-2 py-1 text-xs font-semibold hover:bg-white/30"
        >
          Reload
        </button>
      )}

      {!downloading && (
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
            setDismissed(true);
          }}
          className="relative shrink-0 text-white/80 hover:text-white"
          aria-label="Dismiss the update notice"
          title="Dismiss"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
