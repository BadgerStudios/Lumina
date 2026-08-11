import { useNavigate, useParams, Link } from "react-router-dom";
import { useInvitePreview, useJoinInvite } from "../queries/invites";
import { useAuthStore } from "../store/authStore";
import { ApiError } from "../lib/apiClient";

export function InviteRoute() {
  const { code } = useParams<{ code: string }>();
  const status = useAuthStore((s) => s.status);
  const { data: invite, isLoading, isError, error } = useInvitePreview(code);
  const joinInvite = useJoinInvite();
  const navigate = useNavigate();

  async function handleJoin() {
    if (!code) return;
    await joinInvite.mutateAsync(code);
    navigate(`/channels/${invite!.serverId}`, { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base-900">
      <div className="w-full max-w-md rounded-md bg-base-800 p-8 text-center shadow-lg">
        <img src="/icons/logo-128.png" alt="Lumina" className="mx-auto mb-4 h-16 w-16" />
        {isLoading ? (
          <p className="text-signal-dim">Loading invite…</p>
        ) : isError ? (
          <>
            <h1 className="mb-2 text-xl font-bold text-signal">Invite Invalid</h1>
            <p className="text-sm text-signal-dim">{error instanceof ApiError ? error.message : "This invite could not be found."}</p>
          </>
        ) : invite ? (
          <>
            <h1 className="mb-1 text-xl font-bold text-signal">You've been invited to join a server</h1>
            <p className="mb-6 text-sm text-signal-dim">
              {invite.uses} join{invite.uses === 1 ? "" : "s"} so far
              {invite.maxUses ? ` · ${invite.maxUses - invite.uses} remaining` : ""}
            </p>

            {status === "authenticated" ? (
              <button
                onClick={() => void handleJoin()}
                disabled={joinInvite.isPending}
                className="w-full rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
              >
                {joinInvite.isPending ? "Joining…" : "Accept Invite"}
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-signal-dim">Log in or register to accept this invite.</p>
                <Link to="/login" className="w-full rounded bg-accent py-2.5 font-medium text-white hover:bg-accent-hover">
                  Log In
                </Link>
                <Link to="/register" className="w-full rounded bg-base-600 py-2.5 font-medium text-signal hover:bg-base-500">
                  Register
                </Link>
              </div>
            )}
            {joinInvite.isError ? (
              <p className="mt-3 text-sm text-dnd">
                {joinInvite.error instanceof ApiError ? joinInvite.error.message : "Failed to join"}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
