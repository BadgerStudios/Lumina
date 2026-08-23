import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApplicationDTO, ApplicationWithClientSecretDTO, ApplicationWithTokenDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { reportError } from "../store/toastStore";

/** Backs the Developer Portal section in UserSettingsModal.tsx. */
export function useMyApplications(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.myApplications(),
    queryFn: () => api.get<ApplicationDTO[]>("/applications"),
    enabled,
  });
}

export function useCreateApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { name: string; description?: string | null }) =>
      api.post<ApplicationWithTokenDTO>("/applications", params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't create that application"),
  });
}

export function useRegenerateBotToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) => api.post<ApplicationWithTokenDTO>(`/applications/${applicationId}/regenerate-token`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't regenerate that token"),
  });
}

export function useUpdateRedirectUris() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId, redirectUris }: { applicationId: string; redirectUris: string[] }) =>
      api.patch<ApplicationDTO>(`/applications/${applicationId}/oauth/redirect-uris`, { redirectUris }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't save those redirect URIs"),
  });
}

export function useRegenerateClientSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) => api.post<ApplicationWithClientSecretDTO>(`/applications/${applicationId}/oauth/regenerate-secret`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't regenerate that secret"),
  });
}

export function useUpdateIntents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId, ...body }: { applicationId: string; messageContent?: boolean; serverMembers?: boolean }) =>
      api.patch<{ messageContent: boolean; serverMembers: boolean }>(`/applications/${applicationId}/intents`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't save those intents"),
  });
}

export function useDeleteApplication() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) => api.delete<void>(`/applications/${applicationId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myApplications() });
    },
    onError: (e) => reportError(e, "Couldn't delete that application"),
  });
}
