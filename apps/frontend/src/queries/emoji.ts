import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export interface CustomEmoji {
  id: string;
  name: string;
  imageUrl: string;
  animated: boolean;
  uploaderId: string | null;
  createdAt: string;
}

/**
 * A server's custom emoji.
 *
 * Cached generously and shared by the message renderer, the picker and the settings tab: every
 * message containing `:name:` needs this list to render, so refetching per message list would turn
 * one lookup into one per channel switch.
 */
export function useCustomEmojis(serverId: string | undefined) {
  return useQuery<CustomEmoji[]>({
    queryKey: ["emojis", serverId],
    queryFn: () => api.get(`/servers/${serverId}/emojis`),
    enabled: !!serverId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUploadEmoji(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => {
      const form = new FormData();
      // Order matters: the server reads fields until it hits the file, so `name` must be appended
      // first or it will not have been seen by the time the file part is consumed.
      form.append("name", name);
      form.append("file", file);
      return api.postForm<CustomEmoji>(`/servers/${serverId}/emojis`, form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["emojis", serverId] }),
    onError: (e) => reportError(e, "Couldn't upload that emoji"),
  });
}

export function useRenameEmoji(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<CustomEmoji>(`/servers/${serverId}/emojis/${id}`, { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["emojis", serverId] }),
    onError: (e) => reportError(e, "Couldn't rename that emoji"),
  });
}

export function useDeleteEmoji(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${serverId}/emojis/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["emojis", serverId] }),
    onError: (e) => reportError(e, "Couldn't delete that emoji"),
  });
}
