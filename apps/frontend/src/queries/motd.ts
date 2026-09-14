import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import { reportError } from "../store/toastStore";
import { useAuthStore } from "../store/authStore";

export interface MotdDTO {
  id: string;
  title: string | null;
  body: string;
  publishedAt: string;
}

export interface OwnerMotd extends MotdDTO {
  active: boolean;
  author: { id: string; name: string } | null;
}

/**
 * The notice to show this member, or null.
 *
 * Fetched once per app load and never polled. A message of the day changing while you already have
 * the app open is not a thing worth interrupting you for — it will be there tomorrow, or on the
 * next reload, which is exactly the cadence the feature is named after.
 */
export function useMotd() {
  const signedIn = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: ["motd"],
    queryFn: () => api.get<{ motd: MotdDTO | null }>("/motd"),
    enabled: signedIn,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Mark it read.
 *
 * Takes the id that was actually on screen rather than letting the server pick the active one: if a
 * new notice is published between the read and the dismissal, marking that one seen would swallow
 * it for this person without them ever having seen it.
 */
export function useDismissMotd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (motdId: string) => api.post<{ ok: true }>("/motd/seen", { motdId }),
    onSuccess: () => queryClient.setQueryData(["motd"], { motd: null }),
    // Deliberately quiet. Failing to record a dismissal means seeing the notice again later, which
    // is a far smaller harm than a toast about it.
    onError: () => undefined,
  });
}

/** Owner: everything published recently, newest first. */
export function useMotdHistory(enabled = true) {
  return useQuery({
    queryKey: ["motd", "all"],
    queryFn: () => api.get<{ motds: OwnerMotd[] }>("/motd/all"),
    enabled,
  });
}

export function usePublishMotd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string | null; body: string }) =>
      api.post<{ motd: MotdDTO }>("/motd", body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["motd"] }),
    onError: (e) => reportError(e, "Couldn't publish that notice"),
  });
}

export function useRetireMotd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ ok: true }>("/motd"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["motd"] }),
    onError: (e) => reportError(e, "Couldn't take that notice down"),
  });
}
