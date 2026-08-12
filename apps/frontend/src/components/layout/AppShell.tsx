import { useEffect, useMemo } from "react";
import { Outlet, useLocation, useParams } from "react-router-dom";
import { ServerRail } from "./ServerRail";
import { MobileBottomNav } from "./MobileBottomNav";
import { ActivityFeed } from "./ActivityFeed";
import { VoiceVideoGrid } from "./VoiceVideoGrid";
import { UpdateBanner } from "./UpdateBanner";
import { ModalRoot } from "../modals/ModalRoot";
import { ToastHost } from "../common/ToastHost";
import { IOSInstallHint } from "../common/IOSInstallHint";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { BiometricGate } from "../common/BiometricGate";
import { AgeGateModal } from "../AgeGateModal";
import { useSocketEvents } from "../../socket/useSocketEvents";
import { useRoleSync } from "../../hooks/useRoleSync";
import { useUIStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";
import { useServer } from "../../queries/servers";
import { intColorToHex, mixWithWhite, mixWithBlack } from "../../lib/color";

/** Mounted once for the whole authenticated app: wires the global realtime event subscription
 * (see useSocketEvents.ts — patches TanStack Query cache + zustand stores directly rather than
 * refetching), renders the always-present server rail, hosts every modal (each gates its own
 * visibility off uiStore so only one instance of each ever needs to exist), and — below the
 * ~768px breakpoint the Capacitor Android WebView renders at — the bottom tab bar that replaces
 * top-anchored mobile nav (see MobileBottomNav.tsx). */
export function AppShell() {
  useSocketEvents();
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

  // Server-wide theme (ServerSettingsModal.tsx's "Server theme color") — an owner/MANAGE_SERVER
  // pick that recolors --ion/--aurora/--accent-hover (see index.css) for EVERY member while
  // viewing that server, not just the person who set it. Scoped to only the Outlet subtree
  // (channel/DM content + its sidebars) via a CSS custom property override on this wrapping div
  // — var() resolves per-element against the nearest ancestor's cascaded value, so ServerRail
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-base-800 text-signal">
      {/* Above the update banner: on iPhone this is the difference between the app being a tab and
          being an installed app that can receive notifications at all. Renders nothing on every
          other platform, and nothing once installed. */}
      <IOSInstallHint />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <ServerRail />
        {/* pb reserves room for the fixed MobileBottomNav below md so it never sits on top of
            the composer / DM list content; drawer overlays (ChannelSidebar etc.) are
            position:fixed so this padding doesn't affect them. */}
        <div className="flex h-full min-w-0 flex-1 pb-[calc(3.25rem+env(safe-area-inset-bottom))] md:pb-0" style={accentStyle}>
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
      <ModalRoot />
      <VoiceVideoGrid />
      {mobileDrawer === "activity" && <ActivityFeed />}
      <ToastHost />
      <MobileBottomNav />
    </div>
  );
}
