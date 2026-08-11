import { create } from "zustand";

interface TypingEntry {
  userId: string;
  expiresAt: number;
}

interface TypingState {
  // channelId -> userId -> entry. Patched by socket/useSocketEvents.ts on ServerEvents.TYPING_UPDATE.
  typingByChannel: Record<string, Record<string, TypingEntry>>;
  setTyping: (channelId: string, userId: string, isTyping: boolean) => void;
  pruneExpired: (channelId: string) => void;
}

const TYPING_TTL_MS = 8000;

export const useTypingStore = create<TypingState>((set) => ({
  typingByChannel: {},
  setTyping: (channelId, userId, isTyping) =>
    set((state) => {
      const existing = state.typingByChannel[channelId] ?? {};
      if (!isTyping) {
        if (!(userId in existing)) return state;
        const next = { ...existing };
        delete next[userId];
        return { typingByChannel: { ...state.typingByChannel, [channelId]: next } };
      }
      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: { ...existing, [userId]: { userId, expiresAt: Date.now() + TYPING_TTL_MS } },
        },
      };
    }),
  pruneExpired: (channelId) =>
    set((state) => {
      const existing = state.typingByChannel[channelId];
      if (!existing) return state;
      const now = Date.now();
      const next: Record<string, TypingEntry> = {};
      let changed = false;
      for (const [uid, entry] of Object.entries(existing)) {
        if (entry.expiresAt > now) next[uid] = entry;
        else changed = true;
      }
      if (!changed) return state;
      return { typingByChannel: { ...state.typingByChannel, [channelId]: next } };
    }),
}));
