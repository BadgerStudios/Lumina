import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { OwnerApp } from "./owner/OwnerApp";
import { BanScreen } from "./components/BanScreen";
import { Login } from "./routes/Login";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { useRoleSync } from "./hooks/useRoleSync";
import { useAuthStore } from "./store/authStore";
import { silentRefresh } from "./lib/apiClient";
import { useLogout } from "./queries/auth";
import { isOwner } from "./lib/platformRole";
import "./index.css";

/**
 * Entry point for the standalone owner console — the whole program in the owner Android build.
 *
 * Deliberately does NOT mount the router, the socket connection, or any of the chat app. This build
 * exists to read numbers and act on people; shipping the rest of Lumina inside it would bloat the
 * APK and widen its attack surface for no benefit.
 *
 * The role gate below is presentation only. A stolen or sideloaded owner APK is worth nothing on its
 * own: every /api/owner route independently enforces requireOwner server-side, so signing in with a
 * non-owner account yields exactly this refusal screen and 403s from the API.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function OwnerRoot() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);

  // platformRole only arrives with a login/refresh response, so without this the console keeps
  // rendering owner and master sections for a role that has since been revoked — until a sign-out.
  // The API 403s either way, so this is not the access control; it stops the UI from *claiming*
  // access it no longer has, which is the difference between a clear refusal and a screen full of
  // buttons that all fail. Refreshes on focus, the moment a change is most likely to be waiting.
  useRoleSync();

  useEffect(() => {
    void silentRefresh();
  }, []);

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-base-900 text-signal-faint">
        Loading…
      </div>
    );
  }

  if (!user) return <Login />;
  if (!isOwner(user.platformRole)) return <NotAuthorized />;
  return <OwnerApp />;
}

function NotAuthorized() {
  const logout = useLogout();
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-base-900 p-6">
      <div className="w-full max-w-sm rounded-xl border border-hairline bg-base-800 p-6 text-center">
        <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-flare" />
        <h1 className="font-display text-lg text-signal">Owner access required</h1>
        <p className="mt-2 text-sm text-signal-dim">
          This console is only usable by the platform owner or master account. Yours doesn't have
          that access.
        </p>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="mt-4 w-full rounded-lg bg-base-600 px-4 py-2 text-sm text-signal"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* MemoryRouter, not BrowserRouter. This console navigates by internal state, never by URL —
          but it reuses the main app's Login, which calls useNavigate(), and any react-router hook
          throws outside a Router (the whole app rendered blank until this was added). MemoryRouter
          satisfies that without touching the address bar, which also means it behaves identically
          whether served from the WebView root in the APK or from the /owner-app/ subpath on the
          web; BrowserRouter would need a basename that differs between the two. */}
      <MemoryRouter>
        <BanScreen />
        {/* The owner console has no route fallback and no second screen to fall back to — a throw
            anywhere in it is a blank phone. This is the floor under that. */}
        <ErrorBoundary variant="root" label="The owner console">
          <OwnerRoot />
        </ErrorBoundary>
      </MemoryRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
