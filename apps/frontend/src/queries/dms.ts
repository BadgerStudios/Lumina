import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DMConversationDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reconnectSocket } from "../socket/socketClient";

export function useDMs() {
  return useQuery({
    queryKey: queryKeys.dms(),
    queryFn: () => api.get<DMConversationDTO[]>("/dm"),
  });
}

export function useCreateDM() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { participantIds: string[]; isGroup?: boolean; name?: string | null }) =>
      api.post<DMConversationDTO>("/dm", body),
    onSuccess: (conversation) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) => {
        if (!old) return [conversation];
        const idx = old.findIndex((c) => c.id === conversation.id);
        if (idx === -1) return [conversation, ...old];
        const next = [...old];
        next[idx] = conversation;
        return next;
      });
      // The socket is only auto-joined to `dm:*` rooms at connect time (see
      // realtime/io.ts joinInitialRooms), so a conversation created mid-session needs a
      // fresh connection before its message events can arrive. Cheap and correct for this
      // app's scale; see the note left in io.ts for why this isn't a new ClientEvents entry.
      reconnectSocket();
    },
  });
}

export function useRenameDM() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, name }: { conversationId: string; name: string | null }) =>
      api.patch<DMConversationDTO>(`/dm/${conversationId}`, { name }),
    onSuccess: (conversation) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) =>
        old ? old.map((c) => (c.id === conversation.id ? conversation : c)) : old,
      );
    },
  });
}

export function useAddDMParticipant(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post<DMConversationDTO>(`/dm/${conversationId}/participants`, { userId }),
    onSuccess: (conversation) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) =>
        old ? old.map((c) => (c.id === conversation.id ? conversation : c)) : old,
      );
    },
  });
}

export function useRemoveDMParticipant(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/dm/${conversationId}/participants/${userId}`),
  });
}

/** DMParticipant.lastReadMessageId existed in the schema with zero routes/UI using it — see
 * PATCH /api/dm/:id/read. Cache is patched from the broadcast (ServerEvents.DM_READ_UPDATE,
 * see useSocketEvents.ts) rather than here, since every OTHER participant needs the same
 * update too, not just the caller. */
export function useMarkDMRead(conversationId: string) {
  return useMutation({
    mutationFn: () => api.patch<void>(`/dm/${conversationId}/read`),
  });
}
