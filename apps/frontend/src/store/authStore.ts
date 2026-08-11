import { create } from "zustand";
import type { UserDTO } from "@lumina/shared";

// Access token lives in memory ONLY — never persisted to localStorage/sessionStorage.
// This is deliberate XSS mitigation: a page reload always re-derives the session via
// the httpOnly refresh cookie (see lib/apiClient.ts `silentRefresh`), never from storage.
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  accessToken: string | null;
  user: UserDTO | null;
  status: AuthStatus;
  setSession: (accessToken: string, user: UserDTO) => void;
  setUser: (user: UserDTO) => void;
  setStatus: (status: AuthStatus) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  status: "loading",
  setSession: (accessToken, user) => set({ accessToken, user, status: "authenticated" }),
  setUser: (user) => set({ user }),
  setStatus: (status) => set({ status }),
  clear: () => set({ accessToken: null, user: null, status: "unauthenticated" }),
}));
