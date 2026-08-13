import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { BiometricGate } from "./components/common/BiometricGate";
import { MinorGate } from "./components/parental/MinorGate";
import { startViewportSync } from "./lib/viewport";
import { installInspectGuard } from "./lib/inspectGuard";
import "./index.css";

// Before the first render, not inside an effect: an effect runs after the initial paint, so the app
// would lay out at the CSS fallback height and then jump once the real measurement arrived. This
// also publishes data-orientation/data-viewport on <html> for the whole document to key off.
startViewportSync();

// No-op in a dev build. See the module docblock for what this does and does not achieve.
installInspectGuard();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Outermost, so it also catches a throw in App itself — routing setup, the socket effects,
          the ban screen. Nothing above this point can be caught by React at all. */}
      <ErrorBoundary variant="root" label="Lumina">
        {/* Wraps the whole app, INSIDE the error boundary: a crash in the gate itself must still
            reach the boundary rather than leaving a locked screen with no way out. Renders its
            children untouched unless the lock is on and this is a native build. */}
        <BiometricGate>
          {/* Inside BiometricGate, so an unlocked device is established first — a minor's pairing
              lock is about who is accountable for the account, not about who is holding the phone.
              Renders children untouched for every adult account. */}
          <MinorGate>
            <App />
          </MinorGate>
        </BiometricGate>
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
