import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Permissions } from "@lumina/shared";
import { useAuthStore } from "../store/authStore";
import { useOAuthAuthorizeInfo, useApproveOAuthAuthorization, useInstallBot } from "../queries/oauth2";
import { ApiError } from "../lib/apiClient";

/** Bit -> label, so the consent screen names what is being handed over instead of showing a
 * number. Anything not listed is simply not shown; an unknown bit cannot be consented to
 * meaningfully anyway. */
const PERMISSION_LABELS: [bigint, string][] = [
  [Permissions.VIEW_CHANNELS, "View channels"],
  [Permissions.SEND_MESSAGES, "Send messages"],
  [Permissions.MANAGE_MESSAGES, "Manage messages"],
  [Permissions.MANAGE_CHANNELS, "Manage channels"],
  [Permissions.MANAGE_ROLES, "Manage roles"],
  [Permissions.MANAGE_SERVER, "Manage server"],
  [Permissions.KICK_MEMBERS, "Kick members"],
  [Permissions.BAN_MEMBERS, "Ban members"],
  [Permissions.CREATE_INVITE, "Create invites"],
  [Permissions.MENTION_EVERYONE, "Mention @everyone"],
  [Permissions.ADD_REACTIONS, "Add reactions"],
  [Permissions.ATTACH_FILES, "Attach files"],
  [Permissions.MANAGE_NICKNAMES, "Manage nicknames"],
  [Permissions.TIMEOUT_MEMBERS, "Time out members"],
  [Permissions.VIEW_AUDIT_LOG, "View audit log"],
  [Permissions.MANAGE_WEBHOOKS, "Manage webhooks"],
  [Permissions.MANAGE_EMOJI, "Manage emoji"],
  [Permissions.MANAGE_EVENTS, "Manage events"],
];

function labelPermissions(bits: bigint): string[] {
  return PERMISSION_LABELS.filter(([bit]) => (bits & bit) !== 0n).map(([, label]) => label);
}

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

  const permissions = searchParams.get("permissions") ?? undefined;
  const guildHint = searchParams.get("guild_id") ?? undefined;
  const isBotInstall = scope === "bot";

  // A bot link carries no redirect_uri — approving IS the effect, so requiring one would reject
  // every valid install link.
  const paramsComplete = Boolean(clientId && scope && (isBotInstall || redirectUri));
  const { data: info, isLoading, isError, error } = useOAuthAuthorizeInfo(
    status === "authenticated" && paramsComplete && clientId && scope
      ? { clientId, redirectUri, scope, state, permissions }
      : undefined,
  );
  const approve = useApproveOAuthAuthorization();
  const install = useInstallBot();
  const [chosenServer, setChosenServer] = useState<string | undefined>(guildHint);
  const [installed, setInstalled] = useState<{ name: string; granted: string[] } | null>(null);

  const bot = info?.bot;
  const targetServer = bot?.servers.find((sv) => sv.id === chosenServer);
  const requested = bot ? BigInt(bot.requestedPermissions) : 0n;
  // What will ACTUALLY be granted here: the intersection the server enforces. Showing the raw
  // request would promise the installer something the backend is going to strip.
  const effectiveGrant = targetServer ? requested & BigInt(targetServer.grantablePermissions) : 0n;
  const withheld = targetServer ? requested & ~BigInt(targetServer.grantablePermissions) : 0n;

  async function handleInstall() {
    if (!clientId || !scope || !chosenServer || !info) return;
    const result = await install.mutateAsync({ clientId, scope, permissions, guildId: chosenServer });
    setInstalled({ name: info.name, granted: labelPermissions(BigInt(result.grantedPermissions)) });
  }

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
            <p className="text-sm text-signal-dim">
              This link is missing required parameters (client_id and scope, plus redirect_uri for
              anything other than a bot install).
            </p>
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
            <p className="text-sm text-signal-dim">
              {error instanceof ApiError && /unknown client_id/i.test(error.message)
                ? "This link points at an application that no longer exists on Lumina — it was deleted after the link was made. Ask whoever gave it to you for a fresh one, or prepare the bot again under Server Settings → Bots."
                : error instanceof ApiError
                  ? error.message
                  : "This authorization request is invalid."}
            </p>
          </>
        ) : installed ? (
          <>
            <h1 className="mb-1 text-xl font-bold text-signal">{installed.name} was added</h1>
            <p className="mb-4 text-sm text-signal-dim">
              It joined as a member and can be removed from the server's member list at any time.
            </p>
            {installed.granted.length > 0 ? (
              <ul className="mb-6 rounded-lg bg-base-900 p-4 text-left text-sm text-signal">
                {installed.granted.map((label) => (
                  <li key={label} className="flex items-center gap-2">
                    <span className="text-online">•</span>
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-6 rounded-lg bg-base-900 p-4 text-sm text-signal-dim">
                No extra permissions — it has the same access as any other member.
              </p>
            )}
            <Link to="/" className="block w-full rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover">
              Done
            </Link>
          </>
        ) : info && bot ? (
          <>
            <h1 className="mb-1 text-xl font-bold text-signal">Add {info.name} to a server</h1>
            <p className="mb-4 text-sm text-signal-dim">
              Only servers you own or manage are listed — adding a bot is an administrator's decision.
            </p>

            {bot.servers.length === 0 ? (
              <p className="mb-6 rounded-lg bg-base-900 p-4 text-sm text-signal-dim">
                You don't manage any servers yet. Create one, or ask an admin of the server to open
                this link.
              </p>
            ) : (
              <div className="mb-4 max-h-56 space-y-1 overflow-y-auto rounded-lg bg-base-900 p-2 text-left">
                {bot.servers.map((sv) => (
                  <button
                    key={sv.id}
                    type="button"
                    disabled={sv.alreadyPresent}
                    onClick={() => setChosenServer(sv.id)}
                    className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm ${
                      chosenServer === sv.id ? "bg-accent text-white" : "text-signal hover:bg-base-700"
                    } disabled:opacity-50`}
                  >
                    {sv.iconUrl ? (
                      <img src={sv.iconUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-base-600 text-xs">
                        {sv.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="flex-1 truncate text-left">{sv.name}</span>
                    {sv.alreadyPresent && <span className="text-xs text-signal-faint">already added</span>}
                  </button>
                ))}
              </div>
            )}

            {targetServer && (
              <div className="mb-4 rounded-lg bg-base-900 p-4 text-left text-sm">
                <p className="mb-2 font-semibold text-signal">This will grant:</p>
                {labelPermissions(effectiveGrant).length === 0 ? (
                  <p className="text-signal-dim">Nothing beyond normal member access.</p>
                ) : (
                  <ul className="text-signal">
                    {labelPermissions(effectiveGrant).map((label) => (
                      <li key={label} className="flex items-center gap-2">
                        <span className="text-online">•</span>
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
                {withheld !== 0n && (
                  <p className="mt-3 text-xs text-signal-faint">
                    Not granted, because you don't hold it yourself:{" "}
                    {labelPermissions(withheld).join(", ")}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Link
                to="/"
                className="flex-1 rounded bg-base-600 py-2.5 text-center font-medium text-signal hover:bg-base-500"
              >
                Cancel
              </Link>
              <button
                onClick={() => void handleInstall()}
                disabled={!chosenServer || install.isPending || targetServer?.alreadyPresent}
                className="flex-1 rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {install.isPending ? "Adding…" : "Add to server"}
              </button>
            </div>
            {install.isError ? (
              <p className="mt-3 text-sm text-dnd">
                {install.error instanceof ApiError ? install.error.message : "Failed to add the bot"}
              </p>
            ) : null}
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
