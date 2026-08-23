import { useMutation } from "@tanstack/react-query";
import type { PresenceStatus, UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { reportError } from "../store/toastStore";

export function useUpdateProfile() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (body: {
      displayName?: string | null;
      statusText?: string | null;
      statusEmoji?: string | null;
      bio?: string | null;
      pronouns?: string | null;
      allowDmsFromNonFriends?: boolean;
      allowFriendRequests?: boolean;
    }) => api.patch<UserDTO>("/users/me", body),
    onSuccess: (user) => setUser(user),
    onError: (e) => reportError(e, "Couldn't save that"),
  });
}

export function useUpdateUsername() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (body: { username: string; currentPassword: string }) => api.patch<UserDTO>("/users/me/username", body),
    onSuccess: (user) => setUser(user),
  });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.patch<{ ok: true }>("/users/me/password", body),
  });
}

export function useUploadBanner() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return api.postForm<UserDTO>("/users/me/banner", form);
    },
    onSuccess: (user) => setUser(user),
    // The server re-encodes and can legitimately reject the file (unreadable image, not an
    // image at all). Without this the picture just silently never changes.
    onError: (e) => reportError(e, "Couldn't update your banner"),
  });
}

export function useUpdatePresence() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (presence: PresenceStatus) => api.patch<UserDTO>("/users/me/presence", { presence }),
    onSuccess: (user) => setUser(user),
    onError: (e) => reportError(e, "Couldn't update your status"),
  });
}

export function useUploadAvatar() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file, file.name);
      return api.postForm<UserDTO>("/users/me/avatar", form);
    },
    onSuccess: (user) => setUser(user),
    onError: (e) => reportError(e, "Couldn't update your avatar"),
  });
}

export function useDeleteAccount() {
  const clear = useAuthStore((s) => s.clear);
  return useMutation({
    mutationFn: (currentPassword: string) => api.delete<void>("/users/me", { currentPassword }),
    onSuccess: () => clear(),
  });
}

/** Fetches the export JSON via the authenticated api client (so the Bearer token rides along —
 * a plain <a href> to the endpoint wouldn't carry it), then triggers a browser download from an
 * in-memory Blob rather than navigating to the URL directly. */
export function useExportAccountData() {
  return useMutation({
    mutationFn: async () => {
      const data = await api.get<Record<string, unknown>>("/users/me/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "lumina-export.json";
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => reportError(e, "Couldn't export your data"),
  });
}
