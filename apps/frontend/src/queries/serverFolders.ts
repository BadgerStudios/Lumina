import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServerFolderDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

const KEY = ["serverFolders"] as const;

export function useServerFolders() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<ServerFolderDTO[]>("/server-folders") });
}

export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: string | null }) => api.post<ServerFolderDTO>("/server-folders", body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => reportError(e, "Couldn't create that folder"),
  });
}

export function useUpdateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string | null }) =>
      api.patch<ServerFolderDTO>(`/server-folders/${id}`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => reportError(e, "Couldn't update that folder"),
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/server-folders/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => reportError(e, "Couldn't delete that folder"),
  });
}

/** Sets (or clears, folderId: null) which folder one of your spaces sits in. */
export function useSetServerFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, folderId }: { serverId: string; folderId: string | null }) =>
      api.put<void>(`/server-folders/placements/${serverId}`, { folderId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => reportError(e, "Couldn't move that space"),
  });
}
