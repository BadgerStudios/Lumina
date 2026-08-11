import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionDTO, UserDTO, AgeBracket } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";

interface AuthResponse {
  accessToken: string;
  user: UserDTO;
}

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: (body: { emailOrUsername: string; password: string }) => api.post<AuthResponse>("/auth/login", body),
    onSuccess: (data) => setSession(data.accessToken, data.user),
  });
}

export function useRegister() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: (body: { username: string; email: string; password: string; displayName?: string; ageBracket?: AgeBracket; birthDate?: string }) =>
      api.post<AuthResponse>("/auth/register", body),
    onSuccess: (data) => setSession(data.accessToken, data.user),
  });
}

export function useLogout() {
  const clear = useAuthStore((s) => s.clear);
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => clear(),
    onError: () => clear(),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: () => api.get<SessionDTO[]>("/auth/sessions"),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/auth/sessions/${id}`),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<SessionDTO[]>(["auth", "sessions"], (old) => old?.filter((s) => s.id !== id));
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/sessions/revoke-others"),
    onSuccess: () => {
      queryClient.setQueryData<SessionDTO[]>(["auth", "sessions"], (old) => old?.filter((s) => s.isCurrent));
    },
  });
}
