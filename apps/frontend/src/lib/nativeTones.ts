import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  DEFAULT_TONES,
  PUSH_KINDS,
  isSoundId,
  tonesFrom,
  type DeviceTones,
  type PushKind,
  type SoundId,
} from "@lumina/shared";
import { api } from "./apiClient";
import { CLIENT_TYPE } from "./platform";

/**
 * The tone this phone plays for each kind of notification.
 *
 * The rules live in @lumina/shared notificationSounds.ts and NotificationSoundsPlugin.java; this is
 * the thin bridge between them and the settings screen. The one thing to understand here is the
 * order of operations in saveTones(): server first, then the device. The server row is what every
 * future push is built from, and the device re-creates its channels from that row on every
 * registration (see nativePush.ts) — so if the native step fails, the next start repairs it. The
 * other order would leave a phone playing a tone the server has already stopped naming.
 */

interface NotificationSoundsShape {
  apply(tones: Record<PushKind, string>): Promise<Record<PushKind, string>>;
  current(): Promise<Record<PushKind, string>>;
  preview(options: { name: string }): Promise<void>;
}

const NotificationSounds = registerPlugin<NotificationSoundsShape>("NotificationSounds");

export function isNativeTonesSupported(): boolean {
  return (
    CLIENT_TYPE === "mobile" &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("NotificationSounds")
  );
}

const TONES_KEY = "lumina.tones";

/** What this phone last saved. Local only: the server copy is the truth, this is the form's memory. */
export function rememberedTones(): DeviceTones {
  try {
    const raw = localStorage.getItem(TONES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<PushKind, unknown>>) : null;
    const out = { ...DEFAULT_TONES };
    for (const kind of PUSH_KINDS) {
      const v = parsed?.[kind];
      if (isSoundId(v)) out[kind] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_TONES };
  }
}

export function rememberTones(tones: DeviceTones): void {
  try {
    localStorage.setItem(TONES_KEY, JSON.stringify(tones));
  } catch {
    // Blocked storage only loses the form's memory; the server still has the choice.
  }
}

/** Create the channels for these tones on this phone, retiring any others. No-op off Android. */
export async function applyTonesOnDevice(tones: DeviceTones): Promise<void> {
  if (!isNativeTonesSupported()) return;
  await NotificationSounds.apply(tones);
}

export async function previewTone(id: SoundId): Promise<void> {
  if (!isNativeTonesSupported()) return;
  await NotificationSounds.preview({ name: id });
}

export async function saveTones(token: string, tones: DeviceTones): Promise<DeviceTones> {
  const saved = await api.post<Record<string, unknown>>("/push/device/sounds", {
    token,
    messageSound: tones.message,
    directSound: tones.direct,
    mentionSound: tones.mention,
    channelSound: tones.channel,
  });
  const applied = tonesFrom(saved);
  await applyTonesOnDevice(applied);
  rememberTones(applied);
  return applied;
}
