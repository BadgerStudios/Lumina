import { Capacitor, registerPlugin } from "@capacitor/core";
import { CLIENT_TYPE } from "./platform";

/**
 * Keeps a call alive on Android while the app is not on screen — see VoiceCallService.java for why
 * a locked phone otherwise goes silent and then drops. No-op on the web, desktop and iOS PWA.
 */
interface VoiceCallShape {
  start(options: { title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
  fullScreenStatus(): Promise<{ granted: boolean }>;
  openFullScreenSettings(): Promise<void>;
}

const VoiceCall = registerPlugin<VoiceCallShape>("VoiceCall");

function supported(): boolean {
  return CLIENT_TYPE === "mobile" && Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("VoiceCall");
}

let running = false;

/** Call after a successful join (the app is in front then, which Android requires). Idempotent. */
export function keepCallAlive(title: string): void {
  if (!supported()) return;
  running = true;
  VoiceCall.start({ title, text: "Tap to return to Lumina" }).catch((err: unknown) => {
    running = false;
    console.warn("voice: the call will pause when Lumina is in the background", err);
  });
}

/** Call whenever the call ends, however it ends. */
export function releaseCall(): void {
  if (!supported() || !running) return;
  running = false;
  VoiceCall.stop().catch(() => undefined);
}

/**
 * Whether an incoming call may take over a locked screen. null where that cannot be asked: off
 * Android, or an app build from before the question existed (build 124).
 */
export async function fullScreenCallsAllowed(): Promise<boolean | null> {
  if (!supported()) return null;
  try {
    return (await VoiceCall.fullScreenStatus()).granted;
  } catch {
    return null;
  }
}

export async function openFullScreenCallSettings(): Promise<void> {
  if (!supported()) return;
  await VoiceCall.openFullScreenSettings().catch(() => undefined);
}
