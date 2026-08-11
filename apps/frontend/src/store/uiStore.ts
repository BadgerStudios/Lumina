import { create } from "zustand";

export type ModalType =
  | "createServer"
  | "createChannel"
  | "invite"
  | "roleEditor"
  | "serverSettings"
  | "channelSettings"
  | "groupDMSettings"
  | "notificationSettings"
  | "userSettings"
  | null;

interface ModalPayloads {
  createChannel: { serverId: string; parentId?: string | null };
  invite: { serverId: string };
  roleEditor: { serverId: string; roleId?: string | null };
  serverSettings: { serverId: string; tab?: "overview" | "roles" | "bans" | "auditLog" };
  channelSettings: { serverId: string; channelId: string };
  groupDMSettings: { conversationId: string };
  notificationSettings: { serverId: string };
  userSettings: undefined;
  createServer: undefined;
}

export type Density = "comfortable" | "compact";
/** Full surface themes — each replaces the whole neutral palette (see index.css), unlike
 * AccentTheme which only re-tints the brand hue and stacks on top of any of these. */
export type Theme = "dark" | "light" | "midnight" | "carbon" | "moss" | "parchment" | "slate";

export const THEMES: Theme[] = ["dark", "midnight", "carbon", "moss", "light", "slate", "parchment"];

/** Which themes are dark-on-light vs light-on-dark. Used to pick a sensible default accent preview
 * and to group them in settings — the distinction matters to a person choosing, and is not
 * derivable from the name. */
export const LIGHT_THEMES: Theme[] = ["light", "slate", "parchment"];
export type AccentTheme = "aurora" | "crimson" | "forest" | "solar" | "ocean";
export const ACCENT_THEMES: AccentTheme[] = ["aurora", "crimson", "forest", "solar", "ocean"];
/** Which mobile overlay drawer (<768px, see components/layout/MobileBottomNav.tsx) is open.
 * "activity" has no backing feature yet (no mentions/notifications model in the backend) — it
 * renders an honest placeholder rather than faking data, see MobileBottomNav.tsx. */
export type MobileDrawer = "servers" | "channels" | "members" | "activity" | null;

const DENSITY_KEY = "lumina-density";
const THEME_KEY = "lumina-theme";
const ACCENT_THEME_KEY = "lumina-accent-theme";
const NOTIFICATION_SOUND_KEY = "lumina-notification-sound";
const KEYBINDS_KEY = "lumina-keybinds";

function readStoredNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(NOTIFICATION_SOUND_KEY);
  return stored !== "off";
}

export interface Keybinds {
  toggleMute: string;
  toggleDeafen: string;
}

const DEFAULT_KEYBINDS: Keybinds = { toggleMute: "KeyM", toggleDeafen: "KeyD" };

function readStoredKeybinds(): Keybinds {
  if (typeof window === "undefined") return DEFAULT_KEYBINDS;
  try {
    const stored = window.localStorage.getItem(KEYBINDS_KEY);
    if (!stored) return DEFAULT_KEYBINDS;
    return { ...DEFAULT_KEYBINDS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_KEYBINDS;
  }
}

function readStoredDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(THEME_KEY);
  // Validated against the list rather than a hardcoded pair, so adding a theme doesn't silently
  // reject anyone already using it.
  if (stored && (THEMES as string[]).includes(stored)) return stored as Theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** index.html has already set this attribute before first paint (see its inline bootstrap
 * script) using the exact same precedence — this just keeps it in sync on later toggles. */
function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", theme);
}

function readStoredAccentTheme(): AccentTheme {
  if (typeof window === "undefined") return "aurora";
  const stored = window.localStorage.getItem(ACCENT_THEME_KEY);
  return (ACCENT_THEMES as string[]).includes(stored ?? "") ? (stored as AccentTheme) : "aurora";
}

function applyAccentTheme(accentTheme: AccentTheme): void {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-accent", accentTheme);
}

interface UIState {
  openModal: ModalType;
  modalPayload: unknown;
  memberListCollapsed: boolean;
  density: Density;
  theme: Theme;
  accentTheme: AccentTheme;
  notificationSoundEnabled: boolean;
  keybinds: Keybinds;
  mobileDrawer: MobileDrawer;
  openModalWith: <T extends Exclude<ModalType, null>>(modal: T, payload?: ModalPayloads[T]) => void;
  closeModal: () => void;
  toggleMemberList: () => void;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAccentTheme: (accentTheme: AccentTheme) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setKeybind: (action: keyof Keybinds, code: string) => void;
  openMobileDrawer: (drawer: MobileDrawer) => void;
  closeMobileDrawer: () => void;
}

/** Mobile (<768px, matches the `md` breakpoint used throughout the layout) starts with the
 * member list collapsed since there's no room for a 4th column there — same boolean the
 * existing desktop toggle already used, just a viewport-aware initial value. MemberList itself
 * renders as a fixed overlay instead of an inline column below that breakpoint (see
 * components/layout/MemberList.tsx), so toggling it open on mobile doesn't squeeze the chat
 * pane down to nothing. */
function defaultMemberListCollapsed(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 768;
}

export const useUIStore = create<UIState>((set, get) => ({
  openModal: null,
  modalPayload: undefined,
  memberListCollapsed: defaultMemberListCollapsed(),
  density: readStoredDensity(),
  theme: readStoredTheme(),
  accentTheme: readStoredAccentTheme(),
  notificationSoundEnabled: readStoredNotificationSound(),
  keybinds: readStoredKeybinds(),
  mobileDrawer: null,
  openModalWith: (modal, payload) => set({ openModal: modal, modalPayload: payload }),
  closeModal: () => set({ openModal: null, modalPayload: undefined }),
  toggleMemberList: () => set((s) => ({ memberListCollapsed: !s.memberListCollapsed })),
  setDensity: (density) => {
    window.localStorage.setItem(DENSITY_KEY, density);
    set({ density });
  },
  toggleDensity: () => get().setDensity(get().density === "compact" ? "comfortable" : "compact"),
  setTheme: (theme) => {
    window.localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  // Flips between families rather than between two fixed values — with seven themes, "the other
  // one" is no longer meaningful, so this jumps to the default of the opposite family.
  toggleTheme: () => get().setTheme(LIGHT_THEMES.includes(get().theme) ? "dark" : "light"),
  setAccentTheme: (accentTheme) => {
    window.localStorage.setItem(ACCENT_THEME_KEY, accentTheme);
    applyAccentTheme(accentTheme);
    set({ accentTheme });
  },
  setNotificationSoundEnabled: (enabled) => {
    window.localStorage.setItem(NOTIFICATION_SOUND_KEY, enabled ? "on" : "off");
    set({ notificationSoundEnabled: enabled });
  },
  setKeybind: (action, code) => {
    const next = { ...get().keybinds, [action]: code };
    window.localStorage.setItem(KEYBINDS_KEY, JSON.stringify(next));
    set({ keybinds: next });
  },
  openMobileDrawer: (drawer) => set({ mobileDrawer: drawer }),
  closeMobileDrawer: () => set({ mobileDrawer: null }),
}));
