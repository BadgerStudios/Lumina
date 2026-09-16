import { create } from "zustand";
import type { DesktopScreenSource } from "../lib/desktopShell";

/**
 * An open "share your screen" picker (desktop app only), awaited by voiceStore.toggleScreenShare.
 * A store rather than component state because the caller is the voice engine, not a component.
 */
interface ScreenPickerState {
  request: { sources: DesktopScreenSource[]; resolve: (id: string | null) => void } | null;
  /** Show the picker; resolves with the chosen source id, or null when dismissed. */
  pick: (sources: DesktopScreenSource[]) => Promise<string | null>;
  settle: (id: string | null) => void;
}

export const useScreenPickerStore = create<ScreenPickerState>((set, get) => ({
  request: null,
  pick: (sources) =>
    new Promise((resolve) => {
      // A second request while one is open cancels the first rather than stranding its promise.
      get().request?.resolve(null);
      set({ request: { sources, resolve } });
    }),
  settle: (id) => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(id);
  },
}));
