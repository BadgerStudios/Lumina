import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemberDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";

export function useMembers(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.members(serverId ?? ""),
    queryFn: () => api.get<MemberDTO[]>(`/servers/${serverId}/members`),
    enabled: !!serverId,
  });
}

export function useUpdateMember(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, nickname }: { userId: string; nickname: string | null }) =>
      api.patch<MemberDTO>(`/servers/${serverId}/members/${userId}`, { nickname }),
    onSuccess: (member) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) =>
        old ? old.map((m) => (m.userId === member.userId ? member : m)) : old,
      );
    },
  });
}

export function useKickMember(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/servers/${serverId}/members/${userId}`),
    onSuccess: (_data, userId) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) => old?.filter((m) => m.userId !== userId));
    },
  });
}

export function useAssignRole(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.post<MemberDTO>(`/servers/${serverId}/members/${userId}/roles/${roleId}`),
    onSuccess: (member) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) =>
        old ? old.map((m) => (m.userId === member.userId ? member : m)) : old,
      );
    },
  });
}

export function useRevokeRole(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api.delete<MemberDTO>(`/servers/${serverId}/members/${userId}/roles/${roleId}`),
    onSuccess: (member) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(serverId), (old) =>
        old ? old.map((m) => (m.userId === member.userId ? member : m)) : old,
      );
    },
  });
}
