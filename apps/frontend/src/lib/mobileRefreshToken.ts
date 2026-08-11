// Mobile and desktop clients have no httpOnly-cookie mechanism reaching the backend's origin
// (the Capacitor WebView's origin is capacitor://localhost / https://localhost, the Electron
// renderer's is a custom app:// scheme — see apps/desktop — neither is lumina.luxffa.com), so
// the refresh token travels in the JSON body instead (see backend `service.ts`
// usesBodyRefreshToken/sendTokenResponse) and is persisted on-device via @capacitor/preferences,
// which falls back to localStorage automatically outside a real Capacitor runtime — including
// under Electron — so this same module serves both (harmless in the plain web build too, which
// never calls it).
import { Preferences } from "@capacitor/preferences";

const KEY = "lumina_refresh_token";

export async function getStoredRefreshToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: KEY });
  return value;
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  await Preferences.set({ key: KEY, value: token });
}

export async function clearStoredRefreshToken(): Promise<void> {
  await Preferences.remove({ key: KEY });
}
