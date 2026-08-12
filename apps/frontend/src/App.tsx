import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { silentRefresh } from "./lib/apiClient";
import { connectSocket, disconnectSocket } from "./socket/socketClient";
import { RequireAuth } from "./routes/RequireAuth";
import { AppShell } from "./components/layout/AppShell";
import { Login } from "./routes/Login";
import { Register } from "./routes/Register";
import { HomeRoute } from "./routes/HomeRoute";
import { ChannelRoute } from "./routes/ChannelRoute";
import { ServerRedirect } from "./routes/ServerRedirect";
import { DMRoute } from "./routes/DMRoute";
import { FriendsRoute } from "./routes/FriendsRoute";
import { InviteRoute } from "./routes/InviteRoute";
import { OAuthAuthorizeRoute } from "./routes/OAuthAuthorizeRoute";
import { FeedRoute } from "./routes/FeedRoute";
import { StaffVideosRoute } from "./routes/StaffVideosRoute";
import { StaffTicketsRoute } from "./routes/StaffTicketsRoute";
import { OwnerRoute } from "./routes/OwnerRoute";
import { BanScreen } from "./components/BanScreen";
import { CrashTest } from "./components/common/CrashTest";
import { UploadRoute } from "./routes/UploadRoute";
import { PrivacyRoute } from "./routes/PrivacyRoute";
import { FeaturesRoute } from "./routes/FeaturesRoute";
import { InstallRoute } from "./routes/InstallRoute";
import { VerifyEmailRoute } from "./routes/VerifyEmailRoute";
import { LandingRoute } from "./routes/LandingRoute";
import { CLIENT_TYPE } from "./lib/platform";

/**
 * Decides what the web root shows.
 *
 * `status` matters as much as the token: on a cold load a silent refresh is still in flight, and
 * treating "not yet known" as "logged out" would flash the marketing page at a returning user
 * before bouncing them to the app.
 */
function LandingGate() {
  const status = useAuthStore((s) => s.status);
  const accessToken = useAuthStore((s) => s.accessToken);

  if (status === "loading") return null;
  if (accessToken) return <Navigate to="/app" replace />;
  return <LandingRoute />;
}

export function App() {
  const status = useAuthStore((s) => s.status);
  const accessToken = useAuthStore((s) => s.accessToken);

  // On app load, attempt a silent refresh (httpOnly cookie -> new access token) to restore a
  // session across page reloads, since the access token itself only ever lives in memory.
  useEffect(() => {
    void silentRefresh();
  }, []);

  // Connect/disconnect the realtime socket in lockstep with having a live access token, rather
  // than at import time — avoids ever handshaking with a stale/absent token.
  useEffect(() => {
    if (accessToken) {
      connectSocket();
    } else {
      disconnectSocket();
    }
  }, [accessToken]);

  return (
    <BrowserRouter>
      {/* Rendered above the router: a ban can land on the login screen or mid-session, and both
          must end at the same explanation rather than a route-specific error. */}
      <BanScreen />
      <Routes>
        {/* The public landing page, web only.
            On mobile/desktop builds CLIENT_TYPE is set at build time and `/` is the app itself —
            a native launch opening a marketing page would be absurd, and those builds ship their
            own bundle so they never see the web root. Signed-in web visitors are redirected to
            /app by LandingGate rather than being shown a pitch for something they already use. */}
        {!CLIENT_TYPE && <Route path="/" element={<LandingGate />} />}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/invite/:code" element={<InviteRoute />} />
        <Route path="/oauth2/authorize" element={<OAuthAuthorizeRoute />} />
        <Route path="/upload" element={<UploadRoute />} />
        <Route path="/privacy" element={<PrivacyRoute />} />
        <Route path="/features" element={<FeaturesRoute />} />
        <Route path="/install" element={<InstallRoute />} />
        {/* Signed-out on purpose: the link is often opened on a different device from the one that
            signed up, and requiring a session would fail exactly where it matters. */}
        <Route path="/verify-email" element={<VerifyEmailRoute />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            {/* Native builds have no landing page, so `/` stays the app home exactly as before —
                their bundle is loaded from the device, not from the web root. */}
            {CLIENT_TYPE && <Route path="/" element={<HomeRoute />} />}
            <Route path="/app" element={<HomeRoute />} />
            <Route path="/channels/:serverId" element={<ServerRedirect />} />
            <Route path="/channels/:serverId/:channelId" element={<ChannelRoute />} />
            <Route path="/dm/:conversationId" element={<DMRoute />} />
            <Route path="/friends" element={<FriendsRoute />} />
            <Route path="/foryou" element={<FeedRoute />} />
            <Route path="/staff/videos" element={<StaffVideosRoute />} />
            <Route path="/staff/reports" element={<StaffTicketsRoute />} />
            <Route path="/owner" element={<OwnerRoute />} />
            {/* Dev only — the target for verify-error-boundary.mjs. `import.meta.env.DEV` is
                replaced with a literal false in a production build and the branch is dropped, so
                this route does not exist in anything shipped. */}
            {import.meta.env.DEV && <Route path="/__boom" element={<CrashTest />} />}
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
