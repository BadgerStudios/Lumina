import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { api, ApiError } from "../lib/apiClient";

/**
 * Where the link in the verification email lands.
 *
 * Deliberately usable while signed out. The link is very often opened on a different device from
 * the one that signed up — a phone signup, the email read on a laptop — and requiring a session
 * would make it fail precisely where it is most needed. The token's signature is the authentication.
 */
export function VerifyEmailRoute() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState<string | null>(null);

  // Guards against React 18 StrictMode double-invoking the effect in development, which would fire
  // two redemptions — the second landing after the token was consumed and rendering a failure over
  // a success that already happened.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    if (!token) {
      setState("failed");
      setMessage("That link is missing its token.");
      return;
    }

    api
      .post("/auth/verify-email", { token })
      .then(() => setState("done"))
      .catch((error) => {
        setState("failed");
        setMessage(error instanceof ApiError ? error.message : "That link didn't work.");
      });
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-900 px-6">
      <div className="w-full max-w-md rounded-xl bg-base-800 p-8 text-center">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-14 w-14" />

        {state === "working" && (
          <>
            <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-signal-faint" />
            <p className="text-signal-dim">Confirming your email…</p>
          </>
        )}

        {state === "done" && (
          <>
            <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-online" />
            <h1 className="font-display text-xl text-signal">Email confirmed</h1>
            <p className="mt-2 text-sm text-signal-dim">
              Thanks — that's this address confirmed on your account.
            </p>
            <Link
              to="/app"
              className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Open Lumina
            </Link>
          </>
        )}

        {state === "failed" && (
          <>
            <XCircle className="mx-auto mb-3 h-8 w-8 text-dnd" />
            <h1 className="font-display text-xl text-signal">That link didn't work</h1>
            <p className="mt-2 text-sm text-signal-dim">{message}</p>
            {/* The route out matters more than the apology: a dead link with no next step is how
                someone gives up on an account they already created. */}
            <p className="mt-4 text-xs text-signal-faint">
              Sign in and use “Resend” in Settings to get a fresh link. Links expire after 24 hours,
              and asking for a new one replaces any older ones.
            </p>
            <Link
              to="/login"
              className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
