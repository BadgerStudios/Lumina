import { create } from "zustand";

const MUTED_KEY = "lumina-feed-muted";

/**
 * Defaults to muted, and that is not a preference — every browser blocks autoplay of a video with
 * sound, so an unmuted default means the first card silently refuses to play. Starting muted lets
 * playback begin immediately; the user unmutes once and the choice persists from then on.
 */
function readStoredMuted(): boolean {
  try {
    const raw = localStorage.getItem(MUTED_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

interface FeedState {
  muted: boolean;
  toggleMuted: () => void;
  setMuted: (muted: boolean) => void;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  muted: readStoredMuted(),
  toggleMuted: () => get().setMuted(!get().muted),
  setMuted: (muted) => {
    try {
      localStorage.setItem(MUTED_KEY, String(muted));
    } catch {
      /* private mode / storage disabled — the in-memory value still works for this session */
    }
    set({ muted });
  },
}));
