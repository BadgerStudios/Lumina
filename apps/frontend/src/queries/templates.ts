import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServerDTO, ServerTemplateDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";

export function useMyTemplates() {
  return useQuery<ServerTemplateDTO[]>({
    queryKey: ["templates", "mine"],
    queryFn: () => api.get("/templates"),
    staleTime: 60 * 1000,
  });
}

/** Previewing a template by code, for the "start from a shared template" flow. */
export function useTemplate(code: string | undefined) {
  return useQuery<ServerTemplateDTO>({
    queryKey: ["templates", code],
    queryFn: () => api.get(`/templates/${code}`),
    enabled: !!code && code.length >= 6,
    // A pasted code that turns out not to exist should not be retried three times before the user
    // is told so — they are most likely mid-paste or mid-typo.
    retry: false,
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { serverId: string; name: string; description?: string | null }) =>
      api.post<ServerTemplateDTO>("/templates", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["templates", "mine"] }),
    onError: (e) => reportError(e, "Couldn't save that template"),
  });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, name }: { code: string; name: string }) =>
      api.post<ServerDTO>(`/templates/${code}/apply`, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["templates", "mine"] });
    },
    onError: (e) => reportError(e, "Couldn't create a server from that template"),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.delete(`/templates/${code}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["templates", "mine"] }),
    onError: (e) => reportError(e, "Couldn't delete that template"),
  });
}
