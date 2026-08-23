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
  | "leaderboard"
  | "serverEvents"
  | "game"
  | "userSettings"
  | null;

interface ModalPayloads {
  createChannel: { serverId: string; parentId?: string | null; initialType?: "TEXT" | "CATEGORY" | "VOICE" };
  invite: { serverId: string };
  roleEditor: { serverId: string; roleId?: string | null };
  serverSettings: { serverId: string; tab?: "overview" | "roles" | "bans" | "auditLog" };
  channelSettings: { serverId: string; channelId: string };
  groupDMSettings: { conversationId: string };
  notificationSettings: { serverId: string };
  leaderboard: { serverId: string };
  serverEvents: { serverId: string };
  game: { serverId: string };
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

/** Display metadata for each surface theme — the human name (distinct from the internal key: the
 * default `dark` shows as "Nebula"), a one-line note, and the actual swatch colours so a picker can
 * render a live preview rather than a word. Single source of truth shared by the in-app Appearance
 * settings and the public site theme menu, so the two never drift. */
export const THEME_META: Record<Theme, { label: string; note: string; bg: string; panel: string; raised: string; accent: string }> = {
  dark: { label: "Nebula", note: "The default violet-cast dark", bg: "#0c0a17", panel: "#16121f", raised: "#2a2340", accent: "#5b7cfa" },
  midnight: { label: "Midnight", note: "True black — best on OLED", bg: "#000000", panel: "#0a0a0d", raised: "#1c1c23", accent: "#5b7cfa" },
  carbon: { label: "Carbon", note: "Neutral grey, no colour cast", bg: "#0d0f12", panel: "#14171b", raised: "#262b33", accent: "#5b7cfa" },
  moss: { label: "Moss", note: "Warm green, easiest on the eyes", bg: "#0a1010", panel: "#101917", raised: "#1f2f2a", accent: "#5b7cfa" },
  light: { label: "Daylight", note: "The default light mode", bg: "#f3f1fb", panel: "#ffffff", raised: "#e0daf3", accent: "#4a63e0" },
  slate: { label: "Slate", note: "Cool and low-saturation", bg: "#eef1f5", panel: "#ffffff", raised: "#d6dde7", accent: "#2f6fed" },
  parchment: { label: "Parchment", note: "Warm paper tones", bg: "#f5f1e8", panel: "#fffdf8", raised: "#e5ddcc", accent: "#4a63e0" },
};
export type AccentTheme = "aurora" | "crimson" | "forest" | "solar" | "ocean";
export const ACCENT_THEMES: AccentTheme[] = ["aurora", "crimson", "forest", "solar", "ocean"];
/** Which mobile overlay sheet (<768px, see components/layout/MobileBottomNav.tsx) is open.
 *
 * There used to be two left-hand drawers — "servers" and "channels" — because the desktop layout
 * had two nested left rails and the phone mirrored them. The deck merged those into one column
 * (components/layout/NavDeck.tsx), so there is now exactly one left sheet: "deck". "aside" is the
 * right-hand contextual panel (people/pins), and "activity" is the unified inbox — see
 * components/layout/ActivityFeed.tsx and components/inbox/InboxPanel.tsx. */
export type MobileDrawer = "deck" | "aside" | "activity" | null;

/** The two things worth knowing about a room besides its messages. */
export type AsideTab = "people" | "pins";

const DENSITY_KEY = "lumina-density";
const THEME_KEY = "lumina-theme";
const ACCENT_THEME_KEY = "lumina-accent-theme";
const NOTIFICATION_SOUND_KEY = "lumina-notification-sound";
const KEYBINDS_KEY = "lumina-keybinds";
const DECK_KEY = "lumina-deck-collapsed";

function readStoredNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = window.localStorage.getItem(NOTIFICATION_SOUND_KEY);
  return stored !== "off";
}

export interface Keybinds {
  toggleMute: string;
  toggleDeafen: string;
  pushToTalk: string;
}

/** Push-to-talk defaults to a modifier rather than a letter for the same reason AppShell ignores
 * keybinds while typing: a letter default would transmit every time that letter appeared in a
 * message. A modifier is safe to hold anywhere, including mid-sentence in the composer — which is
 * exactly when people use push-to-talk. */
const DEFAULT_KEYBINDS: Keybinds = { toggleMute: "KeyM", toggleDeafen: "KeyD", pushToTalk: "ControlLeft" };

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
  // Deliberately NOT prefers-color-scheme here: a first-time visitor on an OS set to light mode
  // was greeted with the white `light` palette — a "flash bang" on the public marketing pages and
  // every auth screen. Everyone with no saved choice now gets the soft dark default; light stays
  // one click away in the theme picker. Kept in sync with public/theme-init.js (pre-paint bootstrap).
  return "dark";
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
  /** The right-hand contextual panel (people / pins). Named for the panel, not for the member
   * list it used to be: it now has tabs and outlives any one of them. */
  asideCollapsed: boolean;
  /** The left nav deck, narrowed to icons only. Persisted — someone who works collapsed wants it
   * collapsed tomorrow too. */
  deckCollapsed: boolean;
  /** Which space (community) is expanded to show its rooms in the deck. One at a time: the deck
   * is a single scrolling outline, and every space expanded at once is the wall of text the two
   * -rail layout was trying to avoid. `null` means "whichever one you're currently inside". */
  expandedSpaceId: string | null;
  /** Which tab the aside is showing. Persisted only for the session — the pin button in the room
   * header switches it, so it needs to be settable from outside the panel. */
  asideTab: AsideTab;
  /** The jump-to palette (Ctrl/Cmd-K). */
  commandOpen: boolean;
  density: Density;
  theme: Theme;
  accentTheme: AccentTheme;
  notificationSoundEnabled: boolean;
  keybinds: Keybinds;
  mobileDrawer: MobileDrawer;
  openModalWith: <T extends Exclude<ModalType, null>>(modal: T, payload?: ModalPayloads[T]) => void;
  closeModal: () => void;
  toggleAside: () => void;
  setAsideTab: (tab: AsideTab) => void;
  openAsideTab: (tab: AsideTab) => void;
  toggleDeck: () => void;
  setExpandedSpace: (serverId: string | null) => void;
  setCommandOpen: (open: boolean) => void;
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

/** A compact viewport starts with the member list collapsed since there's no room for a 4th column
 * there — same boolean the existing desktop toggle already used, just a viewport-aware initial
 * value. The aside renders as a fixed right-hand sheet instead of an inline column below that
 * breakpoint (see components/layout/AsidePanel.tsx), so opening it on a phone doesn't squeeze the
 * conversation down to nothing.
 *
 * Reads the same query the `md:` breakpoint uses rather than its own `innerWidth < 768` test: those
 * two disagreed the moment `md` started considering height as well, so a phone in landscape would
 * have opened with the member list expanded on a 390px-tall screen. */
/**
 * Whether the ASIDE is currently an overlay sheet rather than a third column.
 *
 * A wider threshold than the shell's own compact query in lib/viewport.ts (which is where the
 * DECK goes off-canvas),
 * and deliberately: three columns need about 1024px. At tablet-portrait width the deck plus the
 * aside left roughly 250px for the conversation, which is not a conversation. Kept in lockstep with
 * `.lx-sheet--aside` and the `max-lg:` classes in AsidePanel.tsx.
 *
 * Read at call time, not at mount: these actions run in response to a click, and the answer can
 * have changed since the store was created (a rotation, a resized window).
 */
const ASIDE_SHEET_QUERY = "(max-width: 1023.98px)";

function asideIsSheet(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(ASIDE_SHEET_QUERY).matches ?? window.innerWidth < 1024;
}

function defaultAsideCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return asideIsSheet();
}

function readStoredDeckCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DECK_KEY) === "1";
}

/** Is the aside actually visible right now — as a desktop column OR as a phone sheet? The two are
 * driven by different fields, and every consumer needs the answer, not the mechanism. */
export function selectAsideOpen(s: UIState): boolean {
  return s.mobileDrawer === "aside" || !s.asideCollapsed;
}

export const useUIStore = create<UIState>((set, get) => ({
  openModal: null,
  modalPayload: undefined,
  asideCollapsed: defaultAsideCollapsed(),
  asideTab: "people",
  deckCollapsed: readStoredDeckCollapsed(),
  expandedSpaceId: null,
  commandOpen: false,
  density: readStoredDensity(),
  theme: readStoredTheme(),
  accentTheme: readStoredAccentTheme(),
  notificationSoundEnabled: readStoredNotificationSound(),
  keybinds: readStoredKeybinds(),
  mobileDrawer: null,
  openModalWith: (modal, payload) => set({ openModal: modal, modalPayload: payload }),
  closeModal: () => set({ openModal: null, modalPayload: undefined }),
  /**
   * Show or hide the contextual aside.
   *
   * Two different mechanisms, because the panel is two different things: above the layout
   * breakpoint it is a third column governed by `asideCollapsed` (a durable preference), and below
   * it there is no room for a third column so it is an overlay sheet governed by `mobileDrawer`
   * (a momentary state, mutually exclusive with the nav sheet).
   *
   * Deciding that here rather than at each call site is not a style choice — it is the fix for a
   * bug where the header's People and Pinned buttons only ever flipped `asideCollapsed`, so on a
   * phone they set state that nothing rendered off and both panels were simply unreachable.
   */
  toggleAside: () => {
    if (asideIsSheet()) {
      set((s) => ({ mobileDrawer: s.mobileDrawer === "aside" ? null : "aside" }));
      return;
    }
    set((s) => ({ asideCollapsed: !s.asideCollapsed }));
  },
  setAsideTab: (tab) => set({ asideTab: tab }),
  // One action rather than two calls at every site: "show me the pins" means open the panel AND
  // select that tab, and a caller that forgets the first half silently does nothing.
  openAsideTab: (tab) => {
    if (asideIsSheet()) {
      set((s) => ({
        asideTab: tab,
        // Pressing the same button again closes it, matching the desktop behaviour below.
        mobileDrawer: s.mobileDrawer === "aside" && s.asideTab === tab ? null : "aside",
      }));
      return;
    }
    set((s) => (s.asideTab === tab && !s.asideCollapsed ? { asideCollapsed: true } : { asideTab: tab, asideCollapsed: false }));
  },
  toggleDeck: () =>
    set((s) => {
      const next = !s.deckCollapsed;
      window.localStorage.setItem(DECK_KEY, next ? "1" : "0");
      return { deckCollapsed: next };
    }),
  setExpandedSpace: (serverId) => set({ expandedSpaceId: serverId }),
  setCommandOpen: (open) => set({ commandOpen: open }),
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
