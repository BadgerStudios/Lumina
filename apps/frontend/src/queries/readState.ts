import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnreadDTO, ServerUnreadSummaryDTO } from "@lumina/shared";
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

/** Cross-space unread rollup (GET /users/me/unread) — one entry per space that has any unread,
 * with mention totals. Backs the space-rail unread dot and mention badge, including for spaces the
 * user has not opened, which the per-space useUnread cannot see. Same poll cadence. */
export function useGlobalUnread() {
  return useQuery({
    queryKey: queryKeys.globalUnread(),
    queryFn: () => api.get<ServerUnreadSummaryDTO[]>(`/users/me/unread`),
    refetchInterval: 15000,
  });
}

/** Marks every channel in a space read (the space menu's "Mark as read"). Empties that space's
 * per-channel unread cache outright rather than refetching — the server just set every channel's
 * read position to its latest message, so there is nothing left to count. */
export function useMarkServerRead(serverId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>(`/servers/${serverId}/read`),
    onSuccess: () => {
      if (serverId) queryClient.setQueryData<UnreadDTO[]>(queryKeys.unread(serverId), []);
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalUnread() });
    },
    onError: (e) => reportError(e, "Couldn't mark the space as read"),
  });
}

export function useMarkChannelRead(serverId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    // Returns the read position from *before* this call, which is where the "new messages"
    // divider belongs for the session that just opened the channel (see ChannelRoute).
    mutationFn: (channelId: string) =>
      api.patch<{ previousLastReadMessageId: string | null }>(`/channels/${channelId}/read`),
    onSuccess: (_data, channelId) => {
      // The rollup counts this channel too, so nudge it — otherwise the rail dot lingers after
      // the channel itself has gone quiet.
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalUnread() });
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["unread"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalUnread() });
    },
    onError: (e) => reportError(e, "Couldn't mark as unread"),
  });
}
