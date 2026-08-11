import { create } from "zustand";
import type { PresenceStatus } from "@lumina/shared";

interface PresenceState {
  // userId -> presence. Patched directly by socket/useSocketEvents.ts on ServerEvents.PRESENCE_UPDATE,
  // never by refetching. Seeded from each member/user list query as it loads.
  presenceByUserId: Record<string, PresenceStatus>;
  setPresence: (userId: string, presence: PresenceStatus) => void;
  seedPresence: (entries: Array<{ userId: string; presence: PresenceStatus }>) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  presenceByUserId: {},
  setPresence: (userId, presence) =>
    set((state) => ({ presenceByUserId: { ...state.presenceByUserId, [userId]: presence } })),
  seedPresence: (entries) =>
    set((state) => {
      const next = { ...state.presenceByUserId };
      for (const e of entries) {
        // Don't clobber a fresher realtime update with stale seed data if already present.
        if (!(e.userId in next)) next[e.userId] = e.presence;
      }
      return { presenceByUserId: next };
    }),
}));
