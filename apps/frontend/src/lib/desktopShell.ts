import { CLIENT_TYPE } from "./platform";

/** One shareable screen or window, as the desktop shell lists it (apps/desktop/src/screenShare.ts). */
export interface DesktopScreenSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** A PNG data URL, or "" when the platform gives no thumbnail. */
  thumbnail: string;
}

/** What apps/desktop/src/preload.ts exposes on window. */
export interface LuminaDesktopBridge {
  listScreenSources(): Promise<DesktopScreenSource[]>;
  chooseScreenSource(id: string): Promise<boolean>;
}

declare global {
  interface Window {
    luminaDesktop?: LuminaDesktopBridge;
  }
}

/** The desktop shell bridge, or null in the browser and the phone apps. */
export function desktopBridge(): LuminaDesktopBridge | null {
  if (CLIENT_TYPE !== "desktop" || typeof window === "undefined") return null;
  return window.luminaDesktop ?? null;
}
