import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { CLIENT_TYPE } from "./platform";

/**
 * Bridge to the native Android updater (apps/mobile/android/.../AppUpdaterPlugin.java).
 *
 * Only present in the Capacitor build. On web and desktop `registerPlugin` still returns an object,
 * but calling it rejects — every call site here is already gated on CLIENT_TYPE === "mobile", and
 * the two non-Android platforms update by completely different mechanisms anyway (a page reload,
 * and electron-updater in the desktop main process).
 */
export interface AppUpdaterPlugin {
  /** Whether the OS will let this app launch a package installer (Android 8+ per-app grant). */
  canInstall(): Promise<{ value: boolean }>;
  /** Opens the OS settings screen for that grant. */
  openInstallSettings(): Promise<void>;
  /** Downloads the APK, verifies the digest, and opens the system installer. */
  downloadAndInstall(options: { url: string; sha256?: string }): Promise<void>;
  /** The installed app's real version, read from the package at runtime (always current). */
  getVersion(): Promise<{ versionName: string | null; versionCode: number }>;
  /** The certificate this install is signed with, and the package that installed it. */
  getSigningInfo(): Promise<SigningInfo>;
  addListener(
    eventName: "downloadProgress",
    listener: (progress: { loaded: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

/** What the running install is signed with. Every field is nullable on purpose: an older APK
 * running a newer web bundle has no getSigningInfo at all, and some OEM builds refuse to name the
 * installer. Unknown must read as "carry on", never as "mismatch". */
export interface SigningInfo {
  /** SHA-256 of the first signer's certificate, lowercase hex. */
  sha256: string | null;
  /** Every signer, for a multi-signer or rotated install. */
  sha256List: string[];
  /** The installing package — "com.android.vending" for Google Play, null when sideloaded. */
  installer: string | null;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>("AppUpdater");

/** Google Play's package name. A Play install is re-signed with Play's own key, so no APK we
 * publish can ever update it — and Play is already updating it anyway. */
export const PLAY_STORE_PACKAGE = "com.android.vending";

/**
 * The running install's signature, or null off-native / on an APK built before this method existed.
 * Cannot change while the process is alive, so callers cache it indefinitely.
 */
export async function getSigningInfo(): Promise<SigningInfo | null> {
  if (CLIENT_TYPE !== "mobile") return null;
  try {
    const info = await AppUpdater.getSigningInfo();
    return {
      sha256: info?.sha256 ?? null,
      sha256List: Array.isArray(info?.sha256List) ? info.sha256List : [],
      installer: info?.installer ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The installed app's real version from the native package, or null off-native / if the plugin isn't
 * present (an older APK running a newer web bundle). Always reflects the ACTUAL running build — never
 * a stale build-time constant — so the About screen can't show the wrong version.
 */
export async function getInstalledVersion(): Promise<{ versionName: string | null; versionCode: number } | null> {
  if (CLIENT_TYPE !== "mobile") return null;
  try {
    return await AppUpdater.getVersion();
  } catch {
    return null;
  }
}

/** Thrown back as a rejection message by the plugin when "install unknown apps" is not granted. */
export const PERMISSION_REQUIRED = "PERMISSION_REQUIRED";
export const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";
