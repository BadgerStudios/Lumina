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
  addListener(
    eventName: "downloadProgress",
    listener: (progress: { loaded: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>("AppUpdater");

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
