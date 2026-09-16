import { create } from "zustand";
import { DEFAULT_PREFERENCES, type UserPreferencesDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { reportError } from "./toastStore";

/**
 * Account preferences, synced with the server so every device a person signs in on behaves the
 * same. Defaults apply until the load lands (and if it never does), so nothing waits on it.
 *
 * The two preferences that shape the whole document — motion and text size — are applied here
 * rather than by the components that read them, because they must hold on every route.
 */

export type PreferencesPatch = {
  chat?: Partial<UserPreferencesDTO["chat"]>;
  accessibility?: Partial<UserPreferencesDTO["accessibility"]>;
  notifications?: { push?: Partial<UserPreferencesDTO["notifications"]["push"]> };
};

interface PreferencesState {
  prefs: UserPreferencesDTO;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: PreferencesPatch) => Promise<void>;
}

function overlay(base: UserPreferencesDTO, patch: PreferencesPatch): UserPreferencesDTO {
  return {
    chat: { ...base.chat, ...(patch.chat ?? {}) },
    accessibility: { ...base.accessibility, ...(patch.accessibility ?? {}) },
    notifications: { push: { ...base.notifications.push, ...(patch.notifications?.push ?? {}) } },
  };
}

export function applyPreferences(prefs: UserPreferencesDTO): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.reducedMotion = prefs.accessibility.reducedMotion ? "true" : "false";
  // Percent of the browser's own default, so a person's OS-level text size still counts.
  root.style.fontSize = prefs.accessibility.fontScale === 100 ? "" : `${prefs.accessibility.fontScale}%`;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  prefs: DEFAULT_PREFERENCES,
  loaded: false,
  load: async () => {
    try {
      const prefs = await api.get<UserPreferencesDTO>("/users/me/preferences");
      applyPreferences(prefs);
      set({ prefs, loaded: true });
    } catch {
      // Offline or an old server: the defaults stand, and a later change still saves.
      set({ loaded: true });
    }
  },
  update: async (patch) => {
    const before = get().prefs;
    const next = overlay(before, patch);
    applyPreferences(next);
    set({ prefs: next });
    try {
      const saved = await api.patch<UserPreferencesDTO>("/users/me/preferences", patch);
      applyPreferences(saved);
      set({ prefs: saved });
    } catch (e) {
      applyPreferences(before);
      set({ prefs: before });
      reportError(e, "Couldn't save that preference");
    }
  },
}));
