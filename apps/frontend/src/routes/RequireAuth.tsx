import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "../store/authStore";

export function RequireAuth() {
  const status = useAuthStore((s) => s.status);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-base-900 text-signal-dim">
        Loading…
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
