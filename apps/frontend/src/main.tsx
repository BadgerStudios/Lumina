import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { BiometricGate } from "./components/common/BiometricGate";
import "./index.css";

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
          <App />
        </BiometricGate>
      </ErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
