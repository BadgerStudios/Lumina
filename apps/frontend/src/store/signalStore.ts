import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Client-side-only "mute" for the Signal panel (components/layout/SignalPanel.tsx).
 *
 * There is no per-channel notification-preference model in the backend today —
 * ChannelReadState (apps/backend/prisma/schema.prisma) only tracks read position, not mute
 * state. Rather than fake a durable per-channel mute that isn't actually backed by anything on
 * the server, this is intentionally scoped down to: "hide this channel from Signal until it
 * has *new* unread activity beyond what it had when muted." Persisted to localStorage only, for
 * continuity across reloads on this device — never sent to the backend. A real "mute this
 * channel's notifications" feature would need an actual persisted model (e.g. a
 * ChannelNotificationPreference table) as a follow-up.
 */
interface SignalState {
  /** channelId -> the unreadCount that was present at the moment it was muted. */
  mutedAtCount: Record<string, number>;
  muteChannel: (channelId: string, currentUnreadCount: number) => void;
  isHidden: (channelId: string, currentUnreadCount: number) => boolean;
}

export const useSignalStore = create<SignalState>()(
  persist(
    (set, get) => ({
      mutedAtCount: {},
      muteChannel: (channelId, currentUnreadCount) =>
        set((s) => ({ mutedAtCount: { ...s.mutedAtCount, [channelId]: currentUnreadCount } })),
      isHidden: (channelId, currentUnreadCount) => {
        const mutedAt = get().mutedAtCount[channelId];
        return mutedAt !== undefined && currentUnreadCount <= mutedAt;
      },
    }),
    { name: "lumina-signal-mute" },
  ),
);
