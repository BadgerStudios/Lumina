import { registerPlugin } from "@capacitor/core";
import { CLIENT_TYPE } from "./platform";

/**
 * Biometric app lock for the packaged Android builds.
 *
 * The web app uses WebAuthn passkeys; the Capacitor apps cannot, because WebAuthn binds a
 * credential to the registrable domain of the page's origin and these load from
 * `capacitor://localhost`. This is the same feature in the shape the platform allows: a local gate
 * on a session that already exists, rather than a credential the server verifies.
 *
 * **Be precise about what it protects.** It stops someone who picks up an unlocked phone from
 * opening Lumina. It does not protect the stored refresh token from someone with root or physical
 * extraction — the token lives in Capacitor Preferences, not hardware-wrapped storage. A lock on
 * the door, not a safe. The settings copy says exactly that, because a security control people
 * overestimate is worse than one they understand.
 */

export interface BiometricLockPlugin {
  isAvailable(): Promise<{ available: boolean; reason: string }>;
  authenticate(options: { title?: string; subtitle?: string }): Promise<{
    success: boolean;
    reason: string;
  }>;
}

const BiometricLock = registerPlugin<BiometricLockPlugin>("BiometricLock");

/** Persisted per install. Not a security boundary — anyone who can edit localStorage can clear it,
 * and the token it guards is readable by the same person. It records a preference. */
const ENABLED_KEY = "lumina_biometric_lock";

export function isBiometricLockEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBiometricLockEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* storage unavailable — the setting simply does not persist */
  }
}

/**
 * Whether the device can prompt.
 *
 * Returns a reason as well as a boolean so the settings screen can distinguish "this phone has no
 * sensor" from "you haven't set up a fingerprint yet" — the second is something the user can act on
 * and the first is not, and showing the same message for both is how a fixable problem looks
 * permanent.
 */
export async function biometricAvailability(): Promise<{ available: boolean; reason: string }> {
  if (CLIENT_TYPE !== "mobile") return { available: false, reason: "not-native" };
  try {
    return await BiometricLock.isAvailable();
  } catch {
    // The plugin is absent — an older installed APK running a newer web bundle. Not an error worth
    // surfacing; the feature simply is not there.
    return { available: false, reason: "plugin-missing" };
  }
}

/** Prompts. Resolves false on cancel or failure — never throws, because a cancel is a choice. */
export async function requestBiometricUnlock(subtitle?: string): Promise<boolean> {
  if (CLIENT_TYPE !== "mobile") return true;
  try {
    const result = await BiometricLock.authenticate({ title: "Unlock Lumina", subtitle });
    return result.success;
  } catch {
    // Fails OPEN, deliberately. If the prompt itself is broken — a plugin missing after an update,
    // an OS quirk — locking the user out of an app they are already signed into would be a far
    // worse outcome than the lock not applying. The password is still the real gate; this is a
    // convenience layer on top of it.
    return true;
  }
}
