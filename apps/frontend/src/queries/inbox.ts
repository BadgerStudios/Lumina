import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import type { UserDTO } from "@lumina/shared";

export interface InboxItemDTO {
  id: string;
  kind: "REPLY" | "REACTION" | "VIDEO_LIKE" | "VIDEO_COMMENT" | "THREAD" | "FRIEND_ACCEPT" | "LEVEL_UP" | "EARNING";
  actor: Pick<UserDTO, "id" | "username" | "displayName" | "avatarUrl"> | null;
  actorCount: number;
  messageId: string | null;
  channelId: string | null;
  serverId: string | null;
  videoId: string | null;
  preview: string | null;
  readAt: string | null;
  updatedAt: string;
}

export function useInbox(enabled = true) {
  return useQuery({ queryKey: ["inbox"], queryFn: () => api.get<InboxItemDTO[]>("/inbox"), enabled });
}

export function useInboxUnread() {
  return useQuery({
    queryKey: ["inbox", "unread"],
    queryFn: () => api.get<{ count: number }>("/inbox/unread-count"),
    refetchInterval: 60_000, // fallback poll; the socket nudge is the primary signal
  });
}

export function useMarkInboxRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/inbox/read"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
}
