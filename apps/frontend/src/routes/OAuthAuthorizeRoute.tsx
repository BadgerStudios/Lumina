import { useSearchParams, Link } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { useOAuthAuthorizeInfo, useApproveOAuthAuthorization } from "../queries/oauth2";
import { ApiError } from "../lib/apiClient";

/**
 * The consent screen for delegated OAuth2 (authorization-code grant, see modules/oauth2/).
 * Mirrors InviteRoute.tsx's shape: a standalone full-page route (not nested in AppShell), works
 * whether the visitor is already logged in or not, checks its own auth status rather than
 * relying on <RequireAuth> so an unauthenticated visitor sees a clear "log in first" message
 * instead of being silently bounced to "/" and losing the OAuth query params.
 */
export function OAuthAuthorizeRoute() {
  const [searchParams] = useSearchParams();
  const status = useAuthStore((s) => s.status);
  const clientId = searchParams.get("client_id") ?? undefined;
  const redirectUri = searchParams.get("redirect_uri") ?? undefined;
  const scope = searchParams.get("scope") ?? undefined;
  const state = searchParams.get("state") ?? undefined;

  const paramsComplete = clientId && redirectUri && scope;
  const { data: info, isLoading, isError, error } = useOAuthAuthorizeInfo(
    status === "authenticated" && paramsComplete ? { clientId, redirectUri, scope, state } : undefined,
  );
  const approve = useApproveOAuthAuthorization();

  async function handleApprove() {
    if (!clientId || !redirectUri || !scope) return;
    const result = await approve.mutateAsync({ clientId, redirectUri, scope, state });
    window.location.href = result.redirectUrl;
  }

  function handleDeny() {
    if (!redirectUri) return;
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  return (
    <div className="flex min-h-app items-center justify-center bg-base-900">
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 text-center shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />

        {!paramsComplete ? (
          <>
            <h1 className="mb-2 text-xl font-bold text-signal">Invalid Authorization Request</h1>
            <p className="text-sm text-signal-dim">This link is missing required parameters (client_id, redirect_uri, scope).</p>
          </>
        ) : status !== "authenticated" ? (
          <>
            <h1 className="mb-1 text-xl font-bold text-signal">Log in to continue</h1>
            <p className="mb-6 text-sm text-signal-dim">
              An app wants to connect to your Lumina account. Log in, then open this link again.
            </p>
            <Link to="/login" className="w-full rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover">
              Log In
            </Link>
          </>
        ) : isLoading ? (
          <p className="text-signal-dim">Loading…</p>
        ) : isError ? (
          <>
            <h1 className="mb-2 text-xl font-bold text-signal">Can't Authorize This App</h1>
            <p className="text-sm text-signal-dim">{error instanceof ApiError ? error.message : "This authorization request is invalid."}</p>
          </>
        ) : info ? (
          <>
            <h1 className="mb-1 text-xl font-bold text-signal">{info.name} wants to connect</h1>
            <p className="mb-6 text-sm text-signal-dim">This will allow {info.name} to:</p>
            <ul className="mb-6 rounded-lg bg-base-900 p-4 text-left text-sm text-signal">
              {info.scope.split(" ").map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="text-online">•</span>
                  {s === "identify" ? "View your Lumina username and avatar" : s}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={handleDeny}
                className="flex-1 rounded bg-base-600 py-2.5 font-medium text-signal hover:bg-base-500"
              >
                Deny
              </button>
              <button
                onClick={() => void handleApprove()}
                disabled={approve.isPending}
                className="flex-1 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {approve.isPending ? "Approving…" : "Approve"}
              </button>
            </div>
            {approve.isError ? (
              <p className="mt-3 text-sm text-dnd">{approve.error instanceof ApiError ? approve.error.message : "Failed to authorize"}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
