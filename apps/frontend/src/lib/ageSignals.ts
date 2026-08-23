import { Capacitor, registerPlugin } from "@capacitor/core";
import { CLIENT_TYPE } from "./platform";

/**
 * Native age band, from the packaged apps only. Android reads Google Play Age Signals + Play
 * Integrity (AgeSignalsPlugin.java); iOS reads Apple Declared Age Range + App Attest
 * (DeclaredAgeRangePlugin.swift). The web build has no native band and returns null — the account is
 * then assured by the self-declared birthday exactly as before.
 *
 * The returned `attestationToken` is what lets the server TRUST the band (verification/attestation.ts
 * is fail-closed: no valid attestation → the band is ignored). So a null band, a declined share, or
 * an unsupported region all safely degrade to self-declared.
 */

interface NativeAgeResult {
  available: boolean;
  band?: string;
  attestationToken?: string;
  reason?: string;
}

interface AgeSignalsPluginShape {
  requestAgeSignal(options?: { cloudProjectNumber?: number }): Promise<NativeAgeResult>;
}

const AndroidAgeSignals = registerPlugin<AgeSignalsPluginShape>("AgeSignals");
const IosDeclaredAgeRange = registerPlugin<AgeSignalsPluginShape>("DeclaredAgeRange");

export type DeviceAgeSignal = {
  platform: "android" | "ios";
  band: string;
  attestationToken?: string;
};

/**
 * Best-effort. Returns null on web, when the plugin is missing (an older installed app running a
 * newer web bundle — the pattern used across the native bridge here), when the user declines, or when
 * no band is available. Never throws.
 */
export async function getNativeAgeSignal(): Promise<DeviceAgeSignal | null> {
  if (CLIENT_TYPE !== "mobile") return null;
  const platform = Capacitor.getPlatform();
  const plugin = platform === "android" ? AndroidAgeSignals : platform === "ios" ? IosDeclaredAgeRange : null;
  if (!plugin) return null;
  try {
    // Time-boxed: the native Age Signals / Integrity call can stall, and Register awaits this before
    // the signup mutation — an unbounded await would leave the button dead with no feedback (the same
    // failure the mobile refresh-token storage call guards against). On timeout, fall back to
    // self-declared rather than block signup.
    const r = await Promise.race([
      plugin.requestAgeSignal(),
      new Promise<NativeAgeResult>((resolve) => setTimeout(() => resolve({ available: false, reason: "timeout" }), 6000)),
    ]);
    if (r.available && r.band) return { platform: platform as "android" | "ios", band: r.band, attestationToken: r.attestationToken };
  } catch {
    // plugin-missing on an older native build, or the user declined — fall back to self-declared
  }
  return null;
}
