import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SoundboardSoundDTO, StickerDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

/**
 * Stickers and soundboard clips — a server's uploaded "expressions", alongside the custom emoji in
 * queries/emoji.ts. Kept in one file because they share a permission (MANAGE_EMOJI), a settings
 * tab, and an upload shape; splitting them would mean three near-identical files.
 */

export function useStickers(serverId: string | undefined) {
  return useQuery<StickerDTO[]>({
    queryKey: ["stickers", serverId],
    queryFn: () => api.get(`/servers/${serverId}/stickers`),
    enabled: !!serverId,
    // Same reasoning as useCustomEmojis: every message carrying a sticker needs this list to
    // render, so a short stale time would mean a refetch per channel switch.
    staleTime: 5 * 60 * 1000,
  });
}

export function useUploadSticker(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description, file }: { name: string; description?: string; file: File }) => {
      const form = new FormData();
      // Fields before the file, always: the server stops reading parts at the first file part, so
      // anything appended after it is never seen.
      form.append("name", name);
      if (description) form.append("description", description);
      form.append("file", file);
      return api.postForm<StickerDTO>(`/servers/${serverId}/stickers`, form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["stickers", serverId] }),
    onError: (e) => reportError(e, "Couldn't upload that sticker"),
  });
}

export function useDeleteSticker(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${serverId}/stickers/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["stickers", serverId] }),
    onError: (e) => reportError(e, "Couldn't delete that sticker"),
  });
}

export function useSounds(serverId: string | undefined) {
  return useQuery<SoundboardSoundDTO[]>({
    queryKey: ["sounds", serverId],
    queryFn: () => api.get(`/servers/${serverId}/sounds`),
    enabled: !!serverId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUploadSound(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, emoji, file }: { name: string; emoji?: string; file: File }) => {
      const form = new FormData();
      form.append("name", name);
      if (emoji) form.append("emoji", emoji);
      form.append("file", file);
      return api.postForm<SoundboardSoundDTO>(`/servers/${serverId}/sounds`, form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sounds", serverId] }),
    onError: (e) => reportError(e, "Couldn't upload that sound"),
  });
}

export function useDeleteSound(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${serverId}/sounds/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sounds", serverId] }),
    onError: (e) => reportError(e, "Couldn't delete that sound"),
  });
}
