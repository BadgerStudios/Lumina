import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebhookDTO, WebhookWithTokenDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reportError } from "../store/toastStore";

/** Backs the Webhooks tab in ServerSettingsModal.tsx — lists across every channel in the
 * server at once (GET /api/servers/:id/webhooks), not scoped to whichever channel happens to
 * be open. */
export function useServerWebhooks(serverId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.serverWebhooks(serverId ?? ""),
    queryFn: () => api.get<WebhookDTO[]>(`/servers/${serverId}/webhooks`),
    enabled: !!serverId && enabled,
  });
}

export function useCreateWebhook(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, name }: { channelId: string; name: string }) =>
      api.post<WebhookWithTokenDTO>(`/channels/${channelId}/webhooks`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.serverWebhooks(serverId) });
    },
    onError: (e) => reportError(e, "Couldn't create that webhook"),
  });
}

export function useDeleteWebhook(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (webhookId: string) => api.delete<void>(`/webhooks/${webhookId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.serverWebhooks(serverId) });
    },
    onError: (e) => reportError(e, "Couldn't delete that webhook"),
  });
}
