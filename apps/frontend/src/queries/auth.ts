import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionDTO, UserDTO, AgeBracket } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";

interface AuthResponse {
  accessToken: string;
  user: UserDTO;
}

/** What /auth/login returns when the account has a second factor: no session, just a ticket. The
 * two shapes are distinguished by `mfaRequired` rather than by status code, since both are a
 * successful password check. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaTicket: string;
  backupCodesRemaining: number;
}

type LoginResult = AuthResponse | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: (body: { emailOrUsername: string; password: string }) => api.post<LoginResult>("/auth/login", body),
    onSuccess: (data) => {
      // Deliberately does NOT set a session on the challenge branch — there is no token to set. A
      // client that stored something here would be claiming to be signed in halfway through.
      if (!isMfaChallenge(data)) setSession(data.accessToken, data.user);
    },
  });
}

/** Step two: exchange the ticket and a code (TOTP or backup) for a real session. */
export function useVerifyMfa() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: (body: { mfaTicket: string; code: string }) =>
      api.post<AuthResponse>("/auth/login/verify-mfa", body),
    onSuccess: (data) => setSession(data.accessToken, data.user),
  });
}

export interface MfaStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export function useMfaStatus() {
  return useQuery({
    queryKey: ["auth", "mfa"],
    queryFn: () => api.get<MfaStatus>("/auth/mfa"),
  });
}

export function useBeginMfa() {
  return useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthURI: string }>("/auth/mfa/begin"),
  });
}

export function useConfirmMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.post<{ backupCodes: string[] }>("/auth/mfa/confirm", { code }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "mfa"] }),
  });
}

export function useDisableMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.post<void>("/auth/mfa/disable", { password }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "mfa"] }),
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
