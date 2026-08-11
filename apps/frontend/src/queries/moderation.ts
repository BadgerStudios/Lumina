import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditLogEntryDTO, MemberDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

export interface BanDTO {
  serverId: string;
  userId: string;
  reason: string | null;
  bannedById?: string;
  createdAt: string;
}

export function useAuditLog(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.auditLog(serverId ?? ""),
    queryFn: () => api.get<AuditLogEntryDTO[]>(`/servers/${serverId}/audit-log`),
    enabled: !!serverId,
  });
}

export function useBans(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.bans(serverId ?? ""),
    queryFn: () => api.get<BanDTO[]>(`/servers/${serverId}/bans`),
    enabled: !!serverId,
  });
}

export function useBanMember(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; reason?: string | null }) => api.post<BanDTO>(`/servers/${serverId}/bans`, body),
    onSuccess: (ban) => {
      queryClient.setQueryData<BanDTO[]>(queryKeys.bans(serverId), (old) => (old ? [ban, ...old] : [ban]));
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) => old?.filter((m) => m.userId !== ban.userId));
    },
  });
}

export function useUnbanMember(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/servers/${serverId}/bans/${userId}`),
    onSuccess: (_data, userId) => {
      queryClient.setQueryData<BanDTO[]>(queryKeys.bans(serverId), (old) => old?.filter((b) => b.userId !== userId));
    },
  });
}

export function useTimeoutMember(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; until: string | null }) =>
      api.post<MemberDTO>(`/servers/${serverId}/timeout`, body),
    onSuccess: (member) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) =>
        old ? old.map((m) => (m.userId === member.userId ? member : m)) : old,
      );
    },
  });
}
