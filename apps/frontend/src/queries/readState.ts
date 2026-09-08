import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnreadDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reportError } from "../store/toastStore";

/** Backs the Signal panel (components/layout/SignalPanel.tsx). There's no dedicated
 * unread-delta socket event in the shared contract (see socket/useSocketEvents.ts, which
 * invalidates this query's cache on every channel message:create instead of adding a new
 * event), so a modest poll interval keeps it correct even for servers the user isn't currently
 * looking at. */
export function useUnread(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.unread(serverId ?? ""),
    queryFn: () => api.get<UnreadDTO[]>(`/servers/${serverId}/unread`),
    enabled: !!serverId,
    refetchInterval: 15000,
  });
}

export function useMarkChannelRead(serverId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.patch<void>(`/channels/${channelId}/read`),
    onSuccess: (_data, channelId) => {
      if (!serverId) return;
      queryClient.setQueryData<UnreadDTO[]>(queryKeys.unread(serverId), (old) =>
        old ? old.filter((u) => u.channelId !== channelId) : old,
      );
    },
  });
}

/** Marks a channel unread from a given message onward. Invalidates every server's unread cache
 * (the caller — a message toolbar — doesn't necessarily know which server it belongs to). */
export function useMarkChannelUnread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, messageId }: { channelId: string; messageId: string }) =>
      api.patch<void>(`/channels/${channelId}/unread`, { messageId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["unread"] }),
    onError: (e) => reportError(e, "Couldn't mark as unread"),
  });
}
