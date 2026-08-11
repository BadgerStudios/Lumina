import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isMfaChallenge, useLogin, useVerifyMfa } from "../queries/auth";
import { ApiError } from "../lib/apiClient";

export function Login() {
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();
  const verifyMfa = useVerifyMfa();
  const navigate = useNavigate();
  // Held in state rather than a route: a ticket in a URL ends up in history and in any shared link,
  // and it is a credential for the five minutes it lives.
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const result = await login.mutateAsync({ emailOrUsername, password });
      if (isMfaChallenge(result)) {
        setMfaTicket(result.mfaTicket);
        // Cleared immediately: the password has done its job and there is no reason for it to stay
        // in memory (or in a password manager's re-fill) through the second step.
        setPassword("");
        return;
      }
      navigate("/", { replace: true });
    } catch {
      /* error surfaced below via login.error */
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!mfaTicket) return;
    try {
      await verifyMfa.mutateAsync({ mfaTicket, code });
      navigate("/", { replace: true });
    } catch {
      // A spent or expired ticket cannot be retried — the server deletes it on redemption so a
      // wrong code cannot be brute-forced against the same ticket. Sending the user back to the
      // password step is the honest outcome rather than leaving them on a dead form.
      if (verifyMfa.error instanceof ApiError && verifyMfa.error.message.includes("expired")) {
        setMfaTicket(null);
        setCode("");
      }
    }
  }

  if (mfaTicket) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-900">
        <div className="w-full max-w-md rounded-md bg-base-800 p-8 shadow-lg">
          <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
          <h1 className="mb-1 text-center text-2xl font-bold text-signal">Two-factor</h1>
          <p className="mb-6 text-center text-sm text-signal-dim">
            Enter the code from your authenticator app, or a backup code.
          </p>
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase text-signal-dim">Code</span>
              <input
                className="rounded border-none bg-base-900 px-3 py-2.5 font-mono text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                // Lets iOS and Android offer the code straight from the notification/keyboard.
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
            {verifyMfa.isError && (
              <p className="text-sm text-dnd">
                {verifyMfa.error instanceof ApiError ? verifyMfa.error.message : "That code isn't right"}
              </p>
            )}
            <button
              type="submit"
              disabled={verifyMfa.isPending}
              className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {verifyMfa.isPending ? "Checking…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={() => { setMfaTicket(null); setCode(""); }}
              className="text-xs text-signal-faint hover:text-signal"
            >
              Start over
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-900">
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
        <h1 className="mb-1 text-center text-2xl font-bold text-signal">Welcome back</h1>
        <p className="mb-6 text-center text-sm text-signal-dim">We're so excited to see you again!</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Email or Username</span>
            <input
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={emailOrUsername}
              onChange={(e) => setEmailOrUsername(e.target.value)}
              // Mobile keyboards capitalise the first letter and "correct" words by default, which
              // silently turns "lumina" into "Lumina" and produced an Invalid-credentials error
              // with an entirely correct password. The server now matches case-insensitively; this
              // stops the field mangling the input in the first place.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Password</span>
            <input
              type="password"
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {login.isError ? (
            <p className="text-sm text-dnd">
              {login.error instanceof ApiError ? login.error.message : "Login failed"}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={login.isPending}
            className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {login.isPending ? "Logging in…" : "Log In"}
          </button>
        </form>

        <p className="mt-4 text-sm text-signal-dim">
          Need an account?{" "}
          <Link to="/register" className="text-accent hover:underline">
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
