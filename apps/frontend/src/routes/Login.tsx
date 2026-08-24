import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Fingerprint } from "lucide-react";
import { SiteThemeMenu } from "../components/SiteThemeMenu";
import { Turnstile } from "../components/Turnstile";
import { isMfaChallenge, useLogin, useVerifyMfa } from "../queries/auth";
import { ApiError } from "../lib/apiClient";
import {
  isPasskeySupported,
  passkeyErrorMessage,
  passkeysUsableHere,
  signInWithPasskey,
} from "../lib/passkeys";
import { useAuthStore } from "../store/authStore";

export function Login() {
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileKey, setTurnstileKey] = useState(0);
  const login = useLogin();
  const verifyMfa = useVerifyMfa();
  const navigate = useNavigate();
  // Held in state rather than a route: a ticket in a URL ends up in history and in any shared link,
  // and it is a credential for the five minutes it lives.
  const [mfaTicket, setMfaTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const setSession = useAuthStore((s) => s.setSession);
  const [passkeyReady, setPasskeyReady] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  // Async because the real question — "is a biometric or PIN actually configured on this device" —
  // is only answerable by a promise. Checked once on mount; the answer cannot change mid-session.
  useEffect(() => {
    if (!passkeysUsableHere()) return;
    let cancelled = false;
    void isPasskeySupported().then((ok) => {
      if (!cancelled) setPasskeyReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const result = await login.mutateAsync({ emailOrUsername, password, turnstileToken: turnstileToken || undefined });
      if (isMfaChallenge(result)) {
        setMfaTicket(result.mfaTicket);
        // Cleared immediately: the password has done its job and there is no reason for it to stay
        // in memory (or in a password manager's re-fill) through the second step.
        setPassword("");
        return;
      }
      navigate("/", { replace: true });
    } catch {
      // A Turnstile token is single-use: siteverify consumes it on the first attempt, so a retry
      // with the same token is rejected as TURNSTILE_FAILED no matter what the user fixes.
      // Drop it and remount the widget so the next attempt carries a fresh token.
      setTurnstileToken("");
      setTurnstileKey((k) => k + 1);
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
      <div className="flex min-h-app items-center justify-center bg-base-900">
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
    <div className="relative flex min-h-app items-center justify-center bg-base-900">
      <div className="absolute right-4 top-4">
        <SiteThemeMenu />
      </div>
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
              {/* A non-ApiError here means something threw client-side AFTER a request the
                  server may have handled successfully — the generic "Login failed" that used to
                  show gave no way to tell those two apart from on-device. Surfacing the real
                  message (and constructor name, since some throws carry no message at all) turns
                  the phone screen itself into the diagnostic instead of guessing blind. */}
              {login.error instanceof ApiError
                ? login.error.message
                : login.error instanceof Error
                  ? `${login.error.name}: ${login.error.message || "(no message)"}`
                  : `Login failed: ${String(login.error)}`}
            </p>
          ) : null}

          {/* Every login is challenged (see requireTurnstileForLogin). Solving it here means the
              token rides the first request; without an inline widget each sign-in would round-trip
              403 -> challenge modal -> retry, flashing a modal at every user every time. It renders
              nothing when Turnstile is unconfigured, so this stays correct if the keys are removed. */}
          <Turnstile key={turnstileKey} onToken={setTurnstileToken} action="login" />

          <button
            type="submit"
            disabled={login.isPending}
            className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {login.isPending ? "Logging in…" : "Log In"}
          </button>

          {/* Only rendered where it can actually succeed. `isPasskeySupported` asks whether a
              fingerprint/face/PIN is genuinely configured, not merely whether the API exists — a
              button that opens a dialog the device cannot complete is worse than no button. */}
          {passkeyReady && (
            <>
              <div className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-base-600" />
                <span className="text-xs text-signal-faint">or</span>
                <span className="h-px flex-1 bg-base-600" />
              </div>
              <button
                type="button"
                disabled={passkeyBusy}
                onClick={async () => {
                  setPasskeyError(null);
                  setPasskeyBusy(true);
                  try {
                    const result = await signInWithPasskey();
                    setSession(result.accessToken, result.user);
                    navigate("/", { replace: true });
                  } catch (err) {
                    // Returns null for a deliberate cancel, which must not be reported as an
                    // error — the user chose that.
                    setPasskeyError(passkeyErrorMessage(err));
                  } finally {
                    setPasskeyBusy(false);
                  }
                }}
                className="flex items-center justify-center gap-2 rounded border border-base-500 py-2.5 font-medium text-signal hover:bg-base-700 disabled:opacity-60"
              >
                <Fingerprint size={17} />
                {passkeyBusy ? "Waiting for your device…" : "Sign in with a passkey"}
              </button>
              {passkeyError && <p className="text-sm text-dnd">{passkeyError}</p>}
            </>
          )}
        </form>

        <p className="mt-4 text-sm text-signal-dim">
          Need an account?{" "}
          <Link to="/register" className="text-accent hover:underline">
            Register
          </Link>
        </p>
        <p className="mt-1 text-sm text-signal-dim">
          <Link to="/forgot-password" className="text-accent hover:underline">
            Forgot your password?
          </Link>
        </p>
      </div>
    </div>
  );
}
