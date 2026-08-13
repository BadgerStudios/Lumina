import { create } from "zustand";

interface ActiveSelectionState {
  activeServerId: string | null;
  activeChannelId: string | null;
  activeDMConversationId: string | null;
  /** The thread docked open beside the channel, if any. Lives here rather than in ChannelRoute's
   * local state because two separate places open threads — a message's reply affordance and the
   * sidebar's thread list — and lifting it is what lets both drive the same panel. */
  openThreadId: string | null;
  setOpenThread: (threadId: string | null) => void;
  setActiveServer: (serverId: string | null) => void;
  setActiveChannel: (channelId: string | null) => void;
  setActiveDM: (conversationId: string | null) => void;
}

export const useActiveSelectionStore = create<ActiveSelectionState>((set) => ({
  activeServerId: null,
  activeChannelId: null,
  activeDMConversationId: null,
  openThreadId: null,
  setOpenThread: (threadId) => set({ openThreadId: threadId }),
  setActiveServer: (serverId) => set({ activeServerId: serverId }),
  setActiveChannel: (channelId) =>
    // Closing the thread here rather than in an effect: a thread belongs to exactly one channel,
    // so there is no state where a new active channel and an old open thread are both correct.
    set((s) => ({ activeChannelId: channelId, openThreadId: s.activeChannelId === channelId ? s.openThreadId : null })),
  setActiveDM: (conversationId) => set({ activeDMConversationId: conversationId }),
}));
