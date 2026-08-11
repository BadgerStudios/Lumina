import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, resolveAssetUrl } from "../lib/apiClient";
import { APP_VARIANT, CLIENT_TYPE } from "../lib/platform";

// Baked in at build time by deploy.sh (sed into .env.mobile before `build:mobile` runs) —
// undefined on the plain web build, where "is there a newer APK" has no meaning since the web
// bundle is always the one currently being served.
const BUNDLED_ANDROID_VERSION_CODE = Number(import.meta.env.VITE_APP_BUILD ?? 0);

export interface ReleaseInfo {
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface VersionManifest {
  androidVersionCode: number;
  android: (ReleaseInfo & { versionCode: number }) | null;
  /** The owner console APK. Absent on a backend older than this field. */
  owner?: (ReleaseInfo & { versionCode: number }) | null;
}

/** Polls the live backend's currently-published APK version and compares it against the version
 * baked into THIS installed APK at build time. Only meaningful on the native Android client —
 * deploy.sh only bumps ANDROID_VERSION_CODE (and rebuilds the APK) on a full, non---web-only
 * deploy, so this is exactly "is the APK I'm running older than the one currently published".
 *
 * Both Android apps use this. Which *release* is compared is chosen by APP_VARIANT, because the
 * two APKs are different applicationIds: handing the owner console the chat app's download would
 * pass its checksum check and then be refused by the OS at install time, which is a confusing
 * place to discover the mistake. */
export function useAndroidUpdate(): { available: boolean; release: ReleaseInfo | null } {
  const { data } = useQuery({
    queryKey: ["meta", "version"],
    queryFn: () => api.get<VersionManifest>("/meta/version"),
    enabled: CLIENT_TYPE === "mobile",
    refetchInterval: 30 * 60 * 1000,
    staleTime: 30 * 60 * 1000,
    // The owner console has no socket connection by design (see owner-main.tsx), so it never gets
    // the deploy announcement that nudges the chat app. Re-checking when the window regains focus
    // is the substitute: opening the console is the moment the answer is wanted, and it's the
    // moment an occasional-use app is most likely to be running something old.
    refetchOnWindowFocus: APP_VARIANT === "owner",
  });

  if (CLIENT_TYPE !== "mobile" || !data) return { available: false, release: null };

  const published = APP_VARIANT === "owner" ? data.owner : data.android;
  // `owner` is optional: an installed owner APK talking to a backend that predates the field would
  // otherwise read `undefined` as "no update", which is the correct answer, but only by accident.
  // Being explicit means the version comparison below is never run against the wrong app's build.
  if (!published) return { available: false, release: null };
  if (published.versionCode <= BUNDLED_ANDROID_VERSION_CODE) return { available: false, release: null };

  // The manifest carries an app-relative path; the installed APK talks to an absolute API origin
  // compiled into it, so it has to be resolved the same way every other server-side path is.
  return { available: true, release: { ...published, url: resolveAssetUrl(published.url) } };
}

/**
 * Whether the browser is running a build older than the one currently deployed.
 *
 * Compares the entry script the page actually loaded against the one the *current* index.html
 * references. Vite fingerprints that filename with a content hash, so the two disagree if and only
 * if a different bundle has been deployed — no build-time version stamp to wire through Docker, no
 * way for the check to drift from what was really shipped.
 *
 * This matters more than it sounds: nothing here precaches, so a fresh page load is always current,
 * but a tab left open for days keeps running whatever JavaScript it started with. That is how a fix
 * that has been live for a week can still be "broken" for someone.
 */
/** Bumped by the socket listener when the server announces a deploy. Module-level rather than
 * component state so the nudge survives re-renders, and so nothing has to thread a callback from
 * the socket layer down to a banner. */
let nudge = 0;
const nudgeListeners = new Set<() => void>();

/** Called from the APP_UPDATE_AVAILABLE handler — see socket/useSocketEvents.ts. */
export function forceUpdateCheck(): void {
  nudge += 1;
  for (const fn of nudgeListeners) fn();
}

export function useWebUpdateAvailable(): boolean {
  const [stale, setStale] = useState(false);
  const [, setTick] = useState(nudge);

  useEffect(() => {
    // Native builds load index.html off local storage, where this comparison is meaningless.
    if (CLIENT_TYPE !== undefined) return;

    const current = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
    if (!current) return;

    let cancelled = false;

    const check = async (force = false) => {
      // The timer skips hidden tabs to avoid pointless requests, but an explicit announcement is
      // worth acting on even in the background — the answer is then already on screen when the
      // person comes back to it.
      if (!force && document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/index.html", { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        const match = /<script[^>]*\stype="module"[^>]*\ssrc="([^"]+)"/.exec(html);
        if (!match) return;
        const deployed = new URL(match[1], window.location.origin).href;
        if (!cancelled && deployed !== current) setStale(true);
      } catch {
        // Offline, or the deploy is mid-flight. Neither is worth telling anyone about.
      }
    };

    // A deploy announcement runs the check immediately, so the gap between shipping a fix and an
    // already-open tab noticing is a second rather than up to a quarter of an hour.
    const onNudge = () => {
      setTick(nudge);
      void check(true);
    };
    nudgeListeners.add(onNudge);

    const timer = setInterval(() => void check(), 15 * 60 * 1000);
    // Also on focus: coming back to a long-idle tab is the single most likely moment to be
    // running a stale bundle, and the most convenient moment to be told.
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    void check();

    return () => {
      cancelled = true;
      clearInterval(timer);
      nudgeListeners.delete(onNudge);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return stale;
}

export interface UploadLimits {
  maxVideoUploadMb: number;
  maxVideoDurationSec: number;
  maxVideoUploadsPerDay: number;
}

/** Server-declared upload caps, so the upload form can't disagree with what the server will
 * actually accept. Cached hard — these change only on a redeploy. */
export function useUploadLimits() {
  return useQuery({
    queryKey: ["meta", "limits"],
    queryFn: () => api.get<UploadLimits>("/meta/limits"),
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
