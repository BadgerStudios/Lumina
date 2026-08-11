import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLogin } from "../queries/auth";
import { ApiError } from "../lib/apiClient";

export function Login() {
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useLogin();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login.mutateAsync({ emailOrUsername, password });
      navigate("/", { replace: true });
    } catch {
      /* error surfaced below via login.error */
    }
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
