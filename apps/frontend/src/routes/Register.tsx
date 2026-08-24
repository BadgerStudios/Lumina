import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SiteThemeMenu } from "../components/SiteThemeMenu";
import { useRegister } from "../queries/auth";
import { ApiError } from "../lib/apiClient";
import type { AgeBracket } from "@lumina/shared";
import { Turnstile } from "../components/Turnstile";
import { getNativeAgeSignal } from "../lib/ageSignals";

/** Five bands, matching AgeBracket on the server. Coarse on purpose: the platform only needs to
 * know whether an account is a minor, and a band is far less identifying to store than an age. */
const AGE_BRACKETS: Array<{ value: AgeBracket; label: string }> = [
  { value: "AGE_18_24", label: "18–24" },
  { value: "AGE_25_34", label: "25–34" },
  { value: "AGE_35_49", label: "35–49" },
  { value: "AGE_50_PLUS", label: "50+" },
];

export function Register() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [ageBracket, setAgeBracket] = useState<AgeBracket | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileKey, setTurnstileKey] = useState(0);
  const register = useRegister();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setAttemptedSubmit(true);
    if (!ageBracket) return;
    try {
      // On the packaged apps, attach a native age band (Google/Apple) so every signup gets the best
      // free assurance available; null on web and safely ignored server-side without attestation.
      const deviceSignal = (await getNativeAgeSignal()) ?? undefined;
      await register.mutateAsync({
        username,
        email,
        password,
        displayName: displayName || undefined,
        ageBracket: (ageBracket || undefined) as AgeBracket | undefined,
        birthDate: birthDate || undefined,
        turnstileToken: turnstileToken || undefined,
        deviceSignal,
      });
      navigate("/", { replace: true });
    } catch {
      // A Turnstile token is single-use: siteverify consumes it on the first attempt, so a retry
      // with the same token is rejected as TURNSTILE_FAILED no matter what the user fixes.
      // Drop it and remount the widget so the next attempt carries a fresh token.
      setTurnstileToken("");
      setTurnstileKey((k) => k + 1);
      /* surfaced below via register.error */
    }
  }

  return (
    <div className="relative flex min-h-app items-center justify-center bg-base-900">
      <div className="absolute right-4 top-4">
        <SiteThemeMenu />
      </div>
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
        <h1 className="mb-1 text-center text-2xl font-bold text-signal">Create an account</h1>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Username</span>
            <input
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // Same reason as the login field: a keyboard-capitalised username is a login trap
              // the person will hit on every future sign-in.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              autoFocus
              required
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_]+"
              title="letters, numbers, underscore only"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Display name (optional)</span>
            <input
              className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
            />
          </label>
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
              minLength={8}
              maxLength={128}
            />
          </label>

          {register.isError ? (
            <p className="text-sm text-dnd">
              {register.error instanceof ApiError ? register.error.message : "Registration failed"}
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-3">
            <legend className="text-xs font-bold uppercase text-signal-dim">Your age</legend>
            {/* Purpose disclosure lives in the privacy policy rather than inline. The link is
                what keeps this compliant — age data is regulated almost everywhere Lumina could
                operate, and the requirement is that the purpose be stated and reachable, not that
                it be printed on the form itself. */}
            <p className="-mt-1 text-xs text-signal-faint">
              Lumina is for adults — you must be 18 or older to register. Your date of birth is
              never shown on your profile. By registering you agree to our{" "}
              <Link to="/terms" className="text-accent hover:underline">
                terms of service
              </Link>{" "}
              and{" "}
              <Link to="/privacy" className="text-accent hover:underline">
                privacy policy
              </Link>
              .
            </p>

            {/* The bracket buttons are not form inputs, so the browser's own required-field
                validation cannot see them. Without an explicit check the form submitted with no
                bracket at all, which the server then had to reject — or worse, silently accepted
                before the field became mandatory. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {AGE_BRACKETS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => setAgeBracket(b.value)}
                  aria-pressed={ageBracket === b.value}
                  className={
                    "rounded px-2 py-2 text-sm transition ring-1 " +
                    (ageBracket === b.value
                      ? "bg-accent text-white ring-accent"
                      : "bg-base-900 text-signal-dim ring-base-500 hover:text-signal")
                  }
                >
                  {b.label}
                </button>
              ))}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase text-signal-dim">Date of birth</span>
              <input
                type="date"
                className="rounded border-none bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                required
                max={new Date().toISOString().slice(0, 10)}
              />
            </label>
          </fieldset>

          {!ageBracket && (birthDate || attemptedSubmit) ? (
            <p className="-mt-2 text-sm text-dnd">Please choose your age range.</p>
          ) : null}

          <Turnstile key={turnstileKey} onToken={setTurnstileToken} action="signup" />

          <button
            type="submit"
            disabled={register.isPending}
            className="mt-2 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {register.isPending ? "Creating account…" : "Register"}
          </button>
        </form>

        <p className="mt-4 text-sm text-signal-dim">
          Already have an account?{" "}
          <Link to="/login" className="text-accent hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
