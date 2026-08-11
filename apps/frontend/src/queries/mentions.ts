import { useQuery } from "@tanstack/react-query";
import type { MentionFeedItemDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

/** Backs the mobile Activity tab (components/layout/AppShell.tsx). Cache is invalidated live on
 * ServerEvents.NOTIFICATION_MENTION (see socket/useSocketEvents.ts) in addition to this poll,
 * so the poll only matters while the tab is open and idle. */
export function useMyMentions() {
  return useQuery({
    queryKey: queryKeys.myMentions(),
    queryFn: () => api.get<MentionFeedItemDTO[]>("/users/me/mentions"),
    refetchInterval: 30000,
  });
}
