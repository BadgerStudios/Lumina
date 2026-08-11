import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FriendDTO, FriendRequestDTO, FriendSuggestionsResponse } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

// The app-wide QueryClient default (main.tsx) sets staleTime: 15_000 — fine for most data, but
// wrong here: DMSidebar mounts useFriendRequests() on nearly every route (it backs the nav
// badge), so its result is almost always already cached from moments ago by the time someone
// actually opens the Friends view — e.g. a request that arrived 5s ago wouldn't show until the
// 15s staleness window lapsed, even though the whole point of opening this view is to check
// for exactly that. `refetchOnMount: "always"` forces a fresh fetch every time either of these
// mounts, regardless of cached staleness (the 20s poll still covers staying fresh while open).
export function useFriends() {
  return useQuery({
    queryKey: queryKeys.friends(),
    queryFn: () => api.get<FriendDTO[]>("/friends"),
    refetchOnMount: "always",
  });
}

export function useFriendRequests() {
  return useQuery({
    queryKey: queryKeys.friendRequests(),
    queryFn: () => api.get<{ incoming: FriendRequestDTO[]; outgoing: FriendRequestDTO[] }>("/friends/requests"),
    refetchInterval: 20000,
    refetchOnMount: "always",
  });
}

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.post<FriendRequestDTO>("/friends/requests", { username }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests() });
      if (result.status === "ACCEPTED") queryClient.invalidateQueries({ queryKey: queryKeys.friends() });
    },
  });
}

export function useRespondToFriendRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, accept }: { requestId: string; accept: boolean }) =>
      api.post<{ ok: true }>(`/friends/requests/${requestId}/${accept ? "accept" : "decline"}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests() });
      queryClient.invalidateQueries({ queryKey: queryKeys.friends() });
    },
  });
}

export function useRemoveFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/friends/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friends() });
    },
  });
}

/**
 * People you may know.
 *
 * Deliberately NOT `refetchOnMount: "always"` like the two lists above, and with a long staleTime:
 * every response bumps a server-side impression counter (FriendSuggestionState), which decays a
 * suggestion's score and eventually suppresses it. Refetching on every mount would burn through
 * a person's twelve impressions in a single browsing session and quietly empty the panel.
 */
export function useFriendSuggestions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.friendSuggestions(),
    queryFn: () => api.get<FriendSuggestionsResponse>("/friends/suggestions?limit=10"),
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useDismissSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/friends/suggestions/${userId}`),
    // Removed from the cached list immediately rather than refetching: a refetch would return a
    // replacement in the same instant the dismissed row disappears, so the list appears to
    // reshuffle under the cursor instead of simply losing one entry.
    onMutate: (userId) => {
      queryClient.setQueryData<FriendSuggestionsResponse>(queryKeys.friendSuggestions(), (old) =>
        old ? { ...old, suggestions: old.suggestions.filter((s) => s.user.id !== userId) } : old,
      );
    },
  });
}

export function useBlockedUsers(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.blockedUsers(),
    queryFn: () => api.get<FriendDTO[]>("/friends/blocked"),
    enabled,
    refetchOnMount: "always",
  });
}

export function useBlockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.post<void>("/friends/block", { username }),
    onSuccess: () => {
      // Blocking supersedes any existing request/friendship (see service.ts blockUser), so all
      // three lists can change at once.
      queryClient.invalidateQueries({ queryKey: queryKeys.blockedUsers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.friends() });
      queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests() });
    },
  });
}

export function useUnblockUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post<void>(`/friends/${userId}/unblock`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blockedUsers() });
    },
  });
}

