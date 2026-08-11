import { create } from "zustand";

interface ActiveSelectionState {
  activeServerId: string | null;
  activeChannelId: string | null;
  activeDMConversationId: string | null;
  setActiveServer: (serverId: string | null) => void;
  setActiveChannel: (channelId: string | null) => void;
  setActiveDM: (conversationId: string | null) => void;
}

export const useActiveSelectionStore = create<ActiveSelectionState>((set) => ({
  activeServerId: null,
  activeChannelId: null,
  activeDMConversationId: null,
  setActiveServer: (serverId) => set({ activeServerId: serverId }),
  setActiveChannel: (channelId) => set({ activeChannelId: channelId }),
  setActiveDM: (conversationId) => set({ activeDMConversationId: conversationId }),
}));
