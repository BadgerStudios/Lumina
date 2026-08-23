import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/apiClient";

/**
 * Where the reset link lands. Reads `?token=` (exactly like VerifyEmailRoute) and lets the user set a
 * new password. Usable signed-out — the token's signature is the authentication. On success every
 * session is revoked server-side, so the user re-signs in with the new password.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.post("/auth/password/reset", { token, password }),
    onSuccess: () => setDone(true),
  });

  const mismatch = confirm.length > 0 && password !== confirm;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (mismatch || !token) return;
    try {
      await reset.mutateAsync();
    } catch {
      /* surfaced below */
    }
  }

  if (!token) {
    return (
      <Shell>
        <XCircle className="mx-auto mb-3 h-8 w-8 text-dnd" />
        <h1 className="text-xl font-bold text-signal">That link is missing its token</h1>
        <p className="mt-2 text-sm text-signal-dim">Request a fresh reset link and try again.</p>
        <Link to="/forgot-password" className="mt-5 inline-block text-accent hover:underline">
          Request a new link
        </Link>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-online" />
        <h1 className="text-xl font-bold text-signal">Password changed</h1>
        <p className="mt-2 text-sm text-signal-dim">
          Your password is updated and you've been signed out everywhere else. Sign in with your new
          password.
        </p>
        <Link
          to="/login"
          className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Sign in
        </Link>
      </Shell>
    );
  }

  return (
    <div className="flex min-h-app items-center justify-center bg-base-900 px-6">
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
        <h1 className="mb-1 text-center text-2xl font-bold text-signal">Choose a new password</h1>
        <p className="mb-6 text-center text-sm text-signal-dim">At least 8 characters.</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">New password</span>
            <input
              type="password"
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              autoFocus
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Confirm password</span>
            <input
              type="password"
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>

          {mismatch && <p className="text-sm text-dnd">Those passwords don't match.</p>}
          {reset.isError ? (
            <p className="text-sm text-dnd">
              {reset.error instanceof ApiError ? reset.error.message : "That reset link is invalid or has expired."}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={reset.isPending || mismatch}
            className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {reset.isPending ? "Saving…" : "Set new password"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-app items-center justify-center bg-base-900 px-6">
      <div className="w-full max-w-md rounded-xl bg-base-800 p-8 text-center">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-14 w-14" />
        {children}
      </div>
    </div>
  );
}
