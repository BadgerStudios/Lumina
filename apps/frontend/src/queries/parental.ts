import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChildContactDTO, LinkedChildDTO, MessageDTO, MinorStateDTO, ServerDTO, UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { reportError } from "../store/toastStore";

/** The signed-in account's own supervision state. Cheap, and read on nearly every screen that has
 * to decide whether to show a lock — so it is deliberately a long-lived query rather than a
 * per-component fetch. */
export function useMinorState() {
  const userId = useAuthStore((s) => s.user?.id);
  return useQuery({
    queryKey: ["parental", "me", userId],
    queryFn: () => api.get<MinorStateDTO>("/parental/me"),
    // MUST stay disabled while signed out. MinorGate wraps the whole app including the auth
    // pages, and hooks cannot be conditional — so without this the query fired on /register,
    // 401'd, and tripped the api client's refresh-then-logout path, which redirected the visitor
    // off the registration form to /login. Nobody could sign up.
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export function useEnsurePairingCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ pairingCode: string; status: string }>("/parental/me/pairing-code"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental", "me"] }),
  });
}

export function useRedeemPairingCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<{ linkId: string; child: LinkedChildDTO["child"] }>("/parental/redeem", { code }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental"] }),
  });
}

// ---- family code (adult-held, reverse direction) ----

/** The adult's own persistent family code, minted lazily server-side on first read. */
export function useFamilyCode(enabled: boolean) {
  return useQuery({
    queryKey: ["parental", "familyCode"],
    queryFn: () => api.get<{ familyCode: string }>("/parental/me/family-code"),
    enabled,
    staleTime: Infinity,
  });
}

export function useRegenerateFamilyCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ familyCode: string }>("/parental/me/family-code/regenerate"),
    onSuccess: (data) => queryClient.setQueryData(["parental", "familyCode"], data),
    onError: (e) => reportError(e, "Couldn't regenerate your family code"),
  });
}

/** A locked minor (or their parent, on the minor's device) submits an adult's family code to link. */
export function useLinkParent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ parent: { id: string; username: string; displayName: string | null; avatarUrl: string | null } }>(
        "/parental/me/link-parent",
        { code },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental"] }),
  });
}

export function useLinkedChildren() {
  return useQuery({
    queryKey: ["parental", "children"],
    queryFn: () => api.get<LinkedChildDTO[]>("/parental/children"),
  });
}

export function useRevokeLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.delete<void>(`/parental/links/${linkId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental"] }),
  });
}

export function useChildMessages(childId: string | undefined) {
  return useQuery({
    queryKey: ["parental", "messages", childId],
    queryFn: () => api.get<MessageDTO[]>(`/parental/children/${childId}/messages`),
    enabled: !!childId,
  });
}

export function useChildContacts(childId: string | undefined) {
  return useQuery({
    queryKey: ["parental", "contacts", childId],
    queryFn: () => api.get<ChildContactDTO[]>(`/parental/children/${childId}/contacts`),
    enabled: !!childId,
  });
}

export function useChildServers(childId: string | undefined) {
  return useQuery({
    queryKey: ["parental", "servers", childId],
    queryFn: () => api.get<{ joinedAt: string; server: Pick<ServerDTO, "id" | "name" | "iconUrl" | "description"> }[]>(
      `/parental/children/${childId}/servers`,
    ),
    enabled: !!childId,
  });
}

export function useChildFriends(childId: string | undefined) {
  return useQuery({
    queryKey: ["parental", "friends", childId],
    queryFn: () => api.get<{ user: UserDTO; isAdult: boolean }[]>(`/parental/children/${childId}/friends`),
    enabled: !!childId,
  });
}

export function useApproveContact(childId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; note?: string }) =>
      api.post<UserDTO>(`/parental/children/${childId}/approved`, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental", "children"] }),
  });
}

export function useRevokeApprovedContact(childId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/parental/children/${childId}/approved/${userId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["parental", "children"] }),
  });
}
