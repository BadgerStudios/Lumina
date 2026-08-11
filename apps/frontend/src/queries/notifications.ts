import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";

export type NotificationLevel = "ALL" | "MENTIONS" | "NONE";

export interface NotificationOverrideDTO {
  channelId: string | null;
  level: NotificationLevel;
}

export function useNotificationSettings(serverId: string | undefined) {
  return useQuery({
    queryKey: ["servers", serverId, "notification-settings"],
    queryFn: () => api.get<NotificationOverrideDTO[]>(`/servers/${serverId}/notification-settings`),
    enabled: !!serverId,
  });
}

export function useSetNotificationOverride(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { channelId: string | null; level: NotificationLevel }) =>
      api.put<void>(`/servers/${serverId}/notification-settings`, body),
    onSuccess: (_data, body) => {
      queryClient.setQueryData<NotificationOverrideDTO[]>(["servers", serverId, "notification-settings"], (old) => {
        const next = (old ?? []).filter((o) => o.channelId !== body.channelId);
        next.push(body);
        return next;
      });
    },
  });
}
