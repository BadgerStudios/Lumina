import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reportError } from "../store/toastStore";

export function useThreads(channelId: string | undefined, archived = false) {
  return useQuery({
    queryKey: queryKeys.threads(channelId ?? "", archived),
    queryFn: () => api.get<ThreadDTO[]>(`/channels/${channelId}/threads?archived=${archived}`),
    enabled: !!channelId,
  });
}

export function useThread(threadId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.thread(threadId ?? ""),
    queryFn: () => api.get<ThreadDTO>(`/threads/${threadId}`),
    enabled: !!threadId,
  });
}

export function useCreateThread(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; originMessageId?: string; autoArchiveMinutes?: number }) =>
      api.post<ThreadDTO>(`/channels/${channelId}/threads`, body),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadDTO>(queryKeys.thread(thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads(channelId, false) });
      // The origin message renders a "N replies" affordance off its own message cache entry, and
      // the message it hangs off was fetched before the thread existed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages(channelId) });
    },
    onError: (e) => reportError(e, "Couldn't create that thread"),
  });
}

export function useSetThreadJoined(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (joined: boolean) =>
      joined
        ? api.put<void>(`/threads/${threadId}/members/@me`)
        : api.delete<void>(`/threads/${threadId}/members/@me`),
    onSuccess: (_res, joined) => {
      queryClient.setQueryData<ThreadDTO>(queryKeys.thread(threadId), (old) =>
        old ? { ...old, joined, memberCount: old.memberCount + (joined ? 1 : -1) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: (e) => reportError(e, "That didn't go through"),
  });
}

export function useSetThreadArchived(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) => api.patch<ThreadDTO>(`/threads/${threadId}/archive`, { archived }),
    onSuccess: (thread) => {
      queryClient.setQueryData<ThreadDTO>(queryKeys.thread(thread.id), thread);
      // Both lists, not just the one it moved to — it also left the other.
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
    onError: (e) => reportError(e, "Couldn't update that thread"),
  });
}
