import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router-dom";
import { useIsFetching } from "@tanstack/react-query";
import { NavDeck } from "./NavDeck";
import { MobileBottomNav } from "./MobileBottomNav";
import { ActivityFeed } from "./ActivityFeed";
import { VoiceVideoGrid } from "./VoiceVideoGrid";
import { VoiceDock } from "./VoiceDock";
import { CommandPalette } from "./CommandPalette";
import { UpdateBanner } from "./UpdateBanner";
import { ModalRoot } from "../modals/ModalRoot";
import { ToastHost } from "../common/ToastHost";
import { IOSInstallHint } from "../common/IOSInstallHint";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { BiometricGate } from "../common/BiometricGate";
import { AgeGateModal } from "../AgeGateModal";
import { IdentityVerificationGate } from "../IdentityVerificationGate";
import { useSocketEvents } from "../../socket/useSocketEvents";
import { useRoleSync } from "../../hooks/useRoleSync";
import { useUIStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";
import { useServer } from "../../queries/servers";
import { intColorToHex, mixWithWhite, mixWithBlack } from "../../lib/color";

/** Mounted once for the whole authenticated app: wires the global realtime event subscription
 * (see useSocketEvents.ts — patches TanStack Query cache + zustand stores directly rather than
 * refetching), renders the always-present nav deck, hosts every modal (each gates its own
 * visibility off uiStore so only one instance of each ever needs to exist), and — below the
 * ~768px breakpoint the Capacitor Android WebView renders at — the bottom tab bar that replaces
 * top-anchored mobile nav (see MobileBottomNav.tsx).
 *
 * The shell is a CANVAS with panes floating on it, not a row of flush columns. The gap and padding
 * on the content row below are what make the seams between the deck, the conversation and the
 * aside visible; each pane draws its own rounded, hairlined edge (`.lx-pane`). Below the layout
 * breakpoint the padding collapses and panes go full-bleed, because a phone has no width to spend
 * on gutters.
 *
 * Also the home of the two global surfaces that are not routes: the voice dock (a call outlives
 * whatever room you are reading) and the jump palette. */
/**
 * Whether to show the network progress bar.
 *
 * Deliberately NOT `useIsFetching() > 0` on its own. React Query refetches on window focus, on
 * reconnect and on every invalidation, and most of those resolve in well under 100ms — a bar wired
 * straight to that flickers constantly, which trains people to ignore it and makes the app look
 * busier than it is.
 *
 * So: only appear once work has been outstanding past the point a person would notice a delay, and
 * once shown, stay up briefly rather than blinking out. A progress indicator that appears and
 * vanishes within one frame is worse than none.
 */
function useSlowNetwork(delay = 400, linger = 220): boolean {
  const fetching = useIsFetching();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (fetching > 0) {
      const timer = window.setTimeout(() => setVisible(true), delay);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setVisible(false), linger);
    return () => window.clearTimeout(timer);
  }, [fetching, delay, linger]);

  return visible;
}

export function AppShell() {
  useSocketEvents();
  const networkBusy = useSlowNetwork();
  // Picks up a role or age change made elsewhere without needing a sign-out (see useRoleSync).
  useRoleSync();
  const mobileDrawer = useUIStore((s) => s.mobileDrawer);

  // Keybinds (UserSettingsModal.tsx's Voice & Video section) — a top-level listener rather than
  // one scoped to any particular component, since mute/deafen should work no matter what's
  // currently focused/rendered. Ignored while typing in a text input/textarea/contenteditable so
  // a rebound key doesn't hijack normal typing (e.g. rebinding to "D" would otherwise eat every
  // "d" typed into the composer).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (!useVoiceStore.getState().channelId) return;
      const keybinds = useUIStore.getState().keybinds;
      if (e.code === keybinds.toggleMute) {
        e.preventDefault();
        useVoiceStore.getState().toggleMute();
      } else if (e.code === keybinds.toggleDeafen) {
        e.preventDefault();
        useVoiceStore.getState().toggleDeafen();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Push-to-talk. Deliberately a separate listener from the mute/deafen one above, because it
  // needs the opposite policy on two counts:
  //
  //  1. It must survive focus being in the composer. Talking while typing is the main thing
  //     push-to-talk is for, so the "ignore while typing" rule above would defeat it. The default
  //     bind is a modifier precisely so this is safe; if someone rebinds it to a printable
  //     character we fall back to the typing guard, since transmitting on every "v" typed into a
  //     message is worse than a bind that doesn't work in the composer.
  //  2. It needs keyup, and it needs a blur fallback — releasing the key while the window is not
  //     focused delivers no keyup at all, which would strand the microphone open indefinitely.
  useEffect(() => {
    function isPrintable(code: string): boolean {
      return /^(Key|Digit|Numpad)/.test(code) || code === "Space";
    }
    function inEditable(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || Boolean(el?.isContentEditable);
    }
    function relevant(e: KeyboardEvent): boolean {
      const voice = useVoiceStore.getState();
      if (!voice.channelId || voice.micMode !== "ptt") return false;
      const bind = useUIStore.getState().keybinds.pushToTalk;
      if (e.code !== bind) return false;
      return !(isPrintable(bind) && inEditable(e.target));
    }
    function onKeyDown(e: KeyboardEvent) {
      if (!relevant(e)) return;
      if (isPrintable(e.code)) e.preventDefault();
      useVoiceStore.getState().setPttHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      // No `relevant` guard on release: if the mode or focus changed while the key was down, the
      // key still needs to release. Only ever closes the gate, so it is safe to run eagerly.
      if (e.code !== useUIStore.getState().keybinds.pushToTalk) return;
      useVoiceStore.getState().setPttHeld(false);
    }
    function onBlur() {
      useVoiceStore.getState().setPttHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Server-wide theme (ServerSettingsModal.tsx's "Server theme color") — an owner/MANAGE_SERVER
  // pick that recolors --ion/--aurora/--accent-hover (see index.css) for EVERY member while
  // viewing that server, not just the person who set it. Scoped to only the Outlet subtree
  // (channel/DM content + its sidebars) via a CSS custom property override on this wrapping div
  // — var() resolves per-element against the nearest ancestor's cascaded value, so the nav deck
  // (shared across every server) and anything portalled outside this div (modals) are
  // deliberately unaffected. Only active on /channels/:serverId* routes — `serverId` is
  // undefined on /dm, /friends, etc., where useServer's `enabled: !!serverId` makes the query
  // inert.
  const { pathname } = useLocation();
  const { serverId } = useParams<{ serverId?: string }>();
  const { data: server } = useServer(serverId);
  const accentStyle = useMemo(() => {
    if (server?.accentColor === null || server?.accentColor === undefined) return undefined;
    const base = intColorToHex(server.accentColor);
    return {
      "--ion": base,
      "--aurora": mixWithWhite(base, 0.35),
      "--accent-hover": mixWithBlack(base, 0.15),
    } as React.CSSProperties;
  }, [server?.accentColor]);

  return (
    // h-app-safe, not h-screen: `100vh` on mobile is the viewport with the URL bar retracted, so
    // with `overflow-hidden` the bottom nav and composer sat permanently below the fold with no way
    // to scroll to them. The class resolves to the measured visible height minus whatever the
    // on-screen keyboard is covering (see lib/viewport.ts).
    // paddingTop is the system status-bar inset. On Android 15+ (targetSdk 35+) edge-to-edge is
    // FORCED — the WebView draws under the status bar — so whatever is topmost in this column sits
    // beneath the clock and notification icons. That was the update banner, which is the one thing
    // here that appears unannounced and has a tap target in it. Applied on the shell rather than on
    // the banner so it is correct for whatever happens to be topmost (the banner renders only when
    // an update exists), and so it cannot double-pad: the settings modals are position:fixed and
    // carry their own inset, and MobileBottomNav insets the bottom independently.
    //
    // max(env(), var(--android-safe-top)) is the house pattern: iOS/web resolve env(), while Android
    // reports the real measured bar height via MainActivity (env() is unreliably 0 there). Padding,
    // not margin, so bg-base-800 still fills the strip behind the status bar instead of leaving a
    // bare gap above the app.
    <div
      className="lx-canvas flex h-app-safe flex-col overflow-hidden text-signal"
      style={{ paddingTop: "var(--safe-top)" }}
    >
      {/* Fixed, so it sits over the shell without participating in its layout. Only ever shown for
          work slow enough to be worth mentioning — see useSlowNetwork above. */}
      {networkBusy && <div className="lm-progress" aria-hidden="true" />}
      {/* Above the update banner: on iPhone this is the difference between the app being a tab and
          being an installed app that can receive notifications at all. Renders nothing on every
          other platform, and nothing once installed. */}
      <IOSInstallHint />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1 md:gap-2 md:p-2">
        <NavDeck />
        {/* pb reserves room for the fixed MobileBottomNav below md so it never sits on top of
            the composer / conversation list content; the deck and aside sheets are position:fixed
            below that breakpoint so this padding doesn't affect them. */}
        <div
          className="flex h-full min-w-0 flex-1 pb-[calc(var(--bottom-nav-h)+var(--safe-bottom))] md:gap-2 md:pb-0"
          style={accentStyle}
        >
          {/* Inside the rail and the bottom nav, not around them: a channel that throws should
              leave every other channel one tap away, rather than taking the navigation down with
              it and forcing a reload. Keyed by pathname so moving somewhere else clears it. */}
          <ErrorBoundary resetKey={pathname} label="This page">
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
      {/* Above everything: an account with no age on record is restricted until it answers, so the
          prompt has to be reachable from wherever they landed. */}
      <AgeGateModal />
      {/* Runs after AgeGateModal: age on record first, then identity. */}
      <IdentityVerificationGate />
      <ModalRoot />
      <VoiceVideoGrid />
      <VoiceDock />
      <CommandPalette />
      {mobileDrawer === "activity" && <ActivityFeed />}
      <ToastHost />
      <MobileBottomNav />
    </div>
  );
}
