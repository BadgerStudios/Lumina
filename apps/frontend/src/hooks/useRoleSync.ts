import { useEffect } from "react";
import type { UserDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";

/**
 * Keeps the signed-in user's own record fresh without requiring a re-login.
 *
 * platformRole is only delivered with the login/refresh response, so a role granted from the owner
 * dashboard used to be invisible to that person until they signed out and back in — the API let
 * them through immediately while their UI kept redirecting them away. Re-fetching /auth/me closes
 * that gap.
 *
 * Runs on window focus rather than on a timer: role changes are rare, and polling every account in
 * the app on an interval would be a lot of pointless traffic to catch something that happens a
 * handful of times. Tabbing back in is the moment a change is most likely to be waiting.
 */
export function useRoleSync(): void {
  const hasSession = useAuthStore((s) => Boolean(s.accessToken));

  useEffect(() => {
    if (!hasSession) return;

    async function refreshMe() {
      try {
        const me = await api.get<UserDTO>("/auth/me");
        const current = useAuthStore.getState().user;
        // Only write when something actually differs, so this never causes a re-render storm on
        // every focus event.
        if (
          current &&
          (current.platformRole !== me.platformRole ||
            current.ageVerified !== me.ageVerified ||
            current.isMinor !== me.isMinor)
        ) {
          useAuthStore.getState().setUser(me);
        }
      } catch {
        /* a failed refresh must never disturb an otherwise working session */
      }
    }

    function onFocus() {
      void refreshMe();
    }

    void refreshMe();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hasSession]);
}
