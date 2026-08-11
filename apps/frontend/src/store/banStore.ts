import { create } from "zustand";

export interface BanDetails {
  reason: string;
  scope: string;
  expiresAt: string | null;
  banId?: string;
  appealStatus?: string;
}

/**
 * Holds a platform ban surfaced by any API call.
 *
 * Global rather than local to the login form because a ban can land in two very different places: on
 * a login/register attempt, and mid-session on any authenticated request once an owner bans someone
 * who is already using the app. Both must end at the same full-screen explanation, so the state is
 * set centrally in apiClient.ts and rendered once at the app root.
 */
interface BanState {
  ban: BanDetails | null;
  setBan: (ban: BanDetails | null) => void;
}

export const useBanStore = create<BanState>((set) => ({
  ban: null,
  setBan: (ban) => set({ ban }),
}));
