import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../lib/apiClient";
import { Turnstile } from "../components/Turnstile";

/**
 * Request a password reset link. Deliberately usable while signed out. The response is always the
 * same ("if that address has an account, we've emailed a link") whether or not the email exists —
 * the server never reveals which addresses are registered, and neither does this screen.
 */
export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [sent, setSent] = useState(false);

  const request = useMutation({
    mutationFn: () => api.post("/auth/password/forgot", { email, turnstileToken: turnstileToken || undefined }),
    onSuccess: () => setSent(true),
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await request.mutateAsync();
    } catch {
      // A Turnstile token is single-use: siteverify consumes it on the first attempt, so a retry
      // with the same token is rejected as TURNSTILE_FAILED no matter what the user fixes.
      // Drop it and remount the widget so the next attempt carries a fresh token.
      setTurnstileToken("");
      setTurnstileKey((k) => k + 1);
      /* surfaced below */
    }
  }

  return (
    <div className="flex min-h-app items-center justify-center bg-base-900 px-6">
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
        {sent ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-online" />
            <h1 className="mb-1 text-2xl font-bold text-signal">Check your email</h1>
            <p className="mb-6 text-sm text-signal-dim">
              If that address has a Lumina account, we've sent a link to reset your password. It works
              for one hour.
            </p>
            <Link to="/login" className="text-accent hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <h1 className="mb-1 text-center text-2xl font-bold text-signal">Reset your password</h1>
            <p className="mb-6 text-center text-sm text-signal-dim">
              Enter your email and we'll send you a link to choose a new password.
            </p>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase text-signal-dim">Email</span>
                <input
                  type="email"
                  className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="email"
                  autoFocus
                  required
                />
              </label>

              <Turnstile key={turnstileKey} onToken={setTurnstileToken} action="password_reset" />

              {request.isError ? (
                <p className="text-sm text-dnd">
                  {request.error instanceof ApiError ? request.error.message : "Something went wrong — try again."}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={request.isPending}
                className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {request.isPending ? "Sending…" : "Send reset link"}
              </button>
            </form>
            <p className="mt-4 text-sm text-signal-dim">
              Remembered it?{" "}
              <Link to="/login" className="text-accent hover:underline">
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
