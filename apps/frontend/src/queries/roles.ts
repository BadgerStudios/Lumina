import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { upsertRole } from "../socket/cachePatches";
import { reportError } from "../store/toastStore";

export function useRoles(serverId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.roles(serverId ?? ""),
    queryFn: () => api.get<RoleDTO[]>(`/servers/${serverId}/roles`),
    enabled: !!serverId,
  });
}

export function useCreateRole(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; color?: number | null; permissions?: string; position?: number; mentionable?: boolean }) =>
      api.post<RoleDTO>(`/servers/${serverId}/roles`, body),
    onSuccess: (role) => {
      // upsertRole (not a raw append) — same reasoning as useCreateChannel in queries/channels.ts:
      // the creator's own socket may also receive the realtime ROLE_CREATE broadcast for this
      // exact role, and a raw append would double-add it if the broadcast arrives before this
      // onSuccess callback runs.
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(serverId), (old) => upsertRole(old, role));
    },
    onError: (e) => reportError(e, "Couldn't create that role"),
  });
}

export function useUpdateRole(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roleId, ...body }: { roleId: string; name?: string; color?: number | null; permissions?: string; position?: number; mentionable?: boolean }) =>
      api.patch<RoleDTO>(`/roles/${roleId}`, body),
    onSuccess: (role) => {
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(serverId), (old) =>
        old ? old.map((r) => (r.id === role.id ? role : r)) : old,
      );
    },
    onError: (e) => reportError(e, "Couldn't save that role"),
  });
}

export function useDeleteRole(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => api.delete<void>(`/roles/${roleId}`),
    onSuccess: (_data, roleId) => {
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(serverId), (old) => old?.filter((r) => r.id !== roleId));
    },
    onError: (e) => reportError(e, "Couldn't delete that role"),
  });
}
