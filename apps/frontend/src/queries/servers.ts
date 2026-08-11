import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServerDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reconnectSocket } from "../socket/socketClient";
import { reportError } from "../store/toastStore";

export function useServers() {
  return useQuery({
    queryKey: queryKeys.servers(),
    queryFn: () => api.get<ServerDTO[]>("/servers"),
  });
}

export function useServer(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.server(serverId ?? ""),
    queryFn: () => api.get<ServerDTO>(`/servers/${serverId}`),
    enabled: !!serverId,
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; iconUrl?: string | null }) => api.post<ServerDTO>("/servers", body),
    onSuccess: (server) => {
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) => (old ? [...old, server] : [server]));
      // Same reasoning as useCreateDM (queries/dms.ts) — the socket's `server:*` rooms are only
      // computed once at connect time (realtime/io.ts's joinInitialRooms), so without this the
      // creator's own already-connected socket never receives further realtime events (other
      // members joining, channel/role changes) for the server they just created.
      reconnectSocket();
    },
  });
}

export function useUpdateServer(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name?: string;
      iconUrl?: string | null;
      bannerUrl?: string | null;
      accentColor?: number | null;
      systemChannelId?: string | null;
    }) =>
      api.patch<ServerDTO>(`/servers/${serverId}`, body),
    onSuccess: (server) => {
      queryClient.setQueryData(queryKeys.server(serverId), server);
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) =>
        old ? old.map((s) => (s.id === server.id ? server : s)) : old,
      );
    },
    onError: (e) => reportError(e, "Couldn't save the server settings"),
  });
}

function useUploadServerImage(serverId: string, path: "icon" | "banner") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return api.postForm<ServerDTO>(`/servers/${serverId}/${path}`, form);
    },
    onSuccess: (server) => {
      queryClient.setQueryData(queryKeys.server(serverId), server);
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) =>
        old ? old.map((s) => (s.id === server.id ? server : s)) : old,
      );
    },
    onError: (e) => reportError(e, `Couldn't update the server ${path}`),
  });
}

export function useUploadServerIcon(serverId: string) {
  return useUploadServerImage(serverId, "icon");
}

export function useUploadServerBanner(serverId: string) {
  return useUploadServerImage(serverId, "banner");
}

export function useDeleteServer(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/servers/${serverId}`),
    onSuccess: () => {
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) => old?.filter((s) => s.id !== serverId));
    },
  });
}

export function useLeaveServer(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(`/servers/${serverId}/leave`),
    onSuccess: () => {
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) => old?.filter((s) => s.id !== serverId));
    },
  });
}
