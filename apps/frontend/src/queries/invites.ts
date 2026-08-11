import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InviteDTO, MemberDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reconnectSocket } from "../socket/socketClient";

export function useInvites(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.invites(serverId ?? ""),
    queryFn: () => api.get<InviteDTO[]>(`/servers/${serverId}/invites`),
    enabled: !!serverId,
  });
}

export function useCreateInvite(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { maxUses?: number | null; expiresInSeconds?: number | null }) =>
      api.post<InviteDTO>(`/servers/${serverId}/invites`, body),
    onSuccess: (invite) => {
      queryClient.setQueryData<InviteDTO[]>(queryKeys.invites(serverId), (old) => (old ? [invite, ...old] : [invite]));
    },
  });
}

export function useRevokeInvite(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.delete<void>(`/invites/${code}`),
    onSuccess: (_data, code) => {
      queryClient.setQueryData<InviteDTO[]>(queryKeys.invites(serverId), (old) => old?.filter((i) => i.code !== code));
    },
  });
}

/** Public: no auth required, powers the /invite/:code preview route. */
export function useInvitePreview(code: string | undefined) {
  return useQuery({
    queryKey: queryKeys.invitePreview(code ?? ""),
    queryFn: () => api.get<InviteDTO>(`/invites/${code}`),
    enabled: !!code,
    retry: false,
  });
}

export function useJoinInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<MemberDTO>(`/invites/${code}/join`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers() });
      // Same reasoning as useCreateServer (queries/servers.ts) and useCreateDM (queries/dms.ts)
      // — the joiner's own already-connected socket never receives realtime events for a server
      // it joins mid-session without this, since `server:*` rooms are only computed once at
      // socket-connect time (realtime/io.ts's joinInitialRooms).
      reconnectSocket();
    },
  });
}
