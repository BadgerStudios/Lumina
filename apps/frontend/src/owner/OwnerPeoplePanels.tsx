import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { PlatformRole } from "@lumina/shared";
import {
  useOwnerUsers,
  useOwnerBans,
  useBanUser,
  useLiftBan,
  useResolveAppeal,
  useSetPlatformRole,
  type OwnerUserRow,
} from "../queries/owner";
import { UserAvatar } from "../components/common/UserAvatar";
import { Badge, DataList, DataRow, EmptyState, Toolbar } from "./OwnerChrome";
import { OwnerUserDetailPanel } from "./OwnerUserDetailPanel";
import { cn } from "../lib/cn";

const ROLE_LABELS: Record<PlatformRole, string> = {
  USER: "User",
  STAFF: "Staff",
  OWNER: "Owner",
  MASTER: "Master",
};

/**
 * User directory and ban/appeal management.
 *
 * Extracted from the web /owner route so the standalone owner app (and its Android build) renders
 * exactly the same components rather than a second implementation that would drift.
 */
export function OwnerUsersPanel() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [banTarget, setBanTarget] = useState<OwnerUserRow | null>(null);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const { data, isLoading } = useOwnerUsers(search, page);
  const setRole = useSetPlatformRole();
  const liftBan = useLiftBan();
  const assignable = data?.assignableRoles ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      {/* Sticky: filtering a 436-row list otherwise means scrolling back to the top to change the
          search every time. */}
      <Toolbar>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-signal-faint" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search name or email"
            className="w-full rounded-lg border border-[var(--oc-line)] bg-[var(--oc-panel)] py-2 pl-9 pr-3 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
        </div>
      </Toolbar>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
        </div>
      ) : !data || data.users.length === 0 ? (
        <EmptyState
          title={search ? `No account matches "${search}"` : "No users yet"}
          hint={search ? "Search covers username, display name and email." : undefined}
        />
      ) : (
        <>
          <p className="text-xs text-signal-faint">{data.total.toLocaleString()} users</p>
          {setRole.isError && (
            <p className="text-sm text-flare">{(setRole.error as Error).message}</p>
          )}
          <DataList>
            {data.users.map((u) => (
              <DataRow
                key={u.id}
                leading={<UserAvatar avatarUrl={u.avatarUrl} name={u.displayName ?? u.username} size={28} />}
                // Three lines became two, and three near-identical strings became one.
                //
                // Every row previously showed the display name, then "@username", then the email —
                // which for the great majority of accounts are the same word three times, taking
                // three lines to say it. At ~90px per row that is seven people per phone screen on
                // a list of 436. The name and the handle share a line now (and the handle is
                // dropped entirely when it adds nothing), with the email as the subtitle since it
                // is the one genuinely different identifier.
                title={
                  <>
                    {u.displayName ?? u.username}
                    {u.displayName && u.displayName !== u.username && (
                      <span className="ml-1.5 text-xs text-signal-faint">@{u.username}</span>
                    )}
                  </>
                }
                subtitle={u.email}
                meta={`${u.counts.messages} msg · ${u.counts.videos} vid · ${new Date(u.createdAt).toLocaleDateString()}`}
                // A button on the name rather than a handler on the row: the row also holds a role
                // <select> and a Ban button, and a fully clickable row means every attempt to
                // change a role also opens the detail panel.
                onClick={() => setDetailUserId(u.id)}
                actions={
                  <>

                    {u.activeBan ? (
                      <>
                        <Badge tone="bad">Banned</Badge>
                        <button
                          type="button"
                          onClick={() => liftBan.mutate({ groupId: u.activeBan!.groupId })}
                          className="rounded-lg bg-base-600 px-2 py-1 text-xs text-signal hover:bg-base-500"
                        >
                          Lift
                        </button>
                      </>
                    ) : (
                      <>
                        {/* Editable only when the server would actually accept the change: the
                            caller must be allowed to assign roles at all, and to touch someone
                            already at this rank. A master, or a peer owner, renders as a static
                            badge instead of a control that always fails. */}
                        {assignable.length > 0 && assignable.includes(u.platformRole) ? (
                          <select
                            aria-label={`Platform role for ${u.username}`}
                            value={u.platformRole}
                            disabled={setRole.isPending}
                            onChange={(e) =>
                              setRole.mutate({ userId: u.id, platformRole: e.target.value as PlatformRole })
                            }
                            className="rounded-lg border border-[var(--oc-line)] bg-[var(--oc-panel-raised)] px-1.5 py-1 text-xs text-signal disabled:opacity-50"
                          >
                            {assignable.map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Badge
                            tone={
                              u.platformRole === "MASTER"
                                ? "master"
                                : u.platformRole === "OWNER"
                                  ? "owner"
                                  : u.platformRole === "STAFF"
                                    ? "staff"
                                    : undefined
                            }
                          >
                            {ROLE_LABELS[u.platformRole]}
                          </Badge>
                        )}
                        {/* Owners and the master cannot be banned server-side, so no button is
                            offered for them — removing their access is a role change, not a ban. */}
                        {u.platformRole !== "OWNER" && u.platformRole !== "MASTER" && (
                          <button
                            type="button"
                            aria-label={`Ban ${u.username}`}
                            onClick={() => setBanTarget(u)}
                            className="rounded-lg bg-base-600 px-2 py-1 text-xs text-signal hover:bg-flare hover:text-white"
                          >
                            Ban
                          </button>
                        )}
                      </>
                    )}
                  </>
                }
              />
            ))}
          </DataList>

          <p className="text-xs text-signal-faint">
            Role changes take effect immediately and persist across the user's next login. The
            OWNER_EMAILS / STAFF_EMAILS env vars only act as a floor for bootstrapping — they can
            grant a role but never take one away. Master comes solely from MASTER_EMAIL.
          </p>

          <div className="flex justify-between">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-lg bg-base-700 px-3 py-1.5 text-sm text-signal disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={(page + 1) * data.limit >= data.total}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg bg-base-700 px-3 py-1.5 text-sm text-signal disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </>
      )}

      <BanDialog user={banTarget} onClose={() => setBanTarget(null)} />

      {detailUserId && (
        <OwnerUserDetailPanel userId={detailUserId} onClose={() => setDetailUserId(null)} />
      )}
    </div>
  );
}

function BanDialog({ user, onClose }: { user: OwnerUserRow | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [durationDays, setDurationDays] = useState<string>("");
  const [banEmail, setBanEmail] = useState(true);
  const [banDevice, setBanDevice] = useState(true);
  const [banIp, setBanIp] = useState(false);
  const banUser = useBanUser();

  if (!user) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-base-800 p-5">
        <h2 className="mb-1 font-display text-lg text-signal">Ban {user.displayName ?? user.username}</h2>
        <p className="mb-4 text-xs text-signal-faint">
          This revokes every active session immediately and blocks the identifiers you select below.
        </p>

        <div className="space-y-3">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            rows={3}
            placeholder="Reason (shown to the banned user)"
            className="w-full resize-none rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />

          <label className="block">
            <span className="text-sm text-signal-dim">Duration</span>
            <select
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal"
            >
              <option value="">Permanent</option>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="365">1 year</option>
            </select>
          </label>

          <fieldset className="space-y-1.5">
            <legend className="text-sm text-signal-dim">Also block</legend>
            <Checkbox checked={banEmail} onChange={setBanEmail} label="This email address" />
            <Checkbox
              checked={banDevice}
              onChange={setBanDevice}
              label="Known devices"
              hint="Browser fingerprint — catches a new signup from the same browser. A different browser or machine defeats it."
            />
            <Checkbox
              checked={banIp}
              onChange={setBanIp}
              label="Recent IP addresses"
              hint="Highest collateral risk: shared houses, offices and mobile carriers put many unrelated people behind one address."
            />
          </fieldset>

          {banUser.isError && (
            <p className="text-sm text-flare">{(banUser.error as Error).message}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={!reason.trim() || banUser.isPending}
              onClick={() =>
                banUser.mutate(
                  {
                    userId: user.id,
                    reason: reason.trim(),
                    durationDays: durationDays ? Number(durationDays) : null,
                    banEmail,
                    banIp,
                    banDevice,
                  },
                  { onSuccess: onClose },
                )
              }
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-flare px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {banUser.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Ban user
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-base-600 px-4 py-2 text-signal"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span>
        <span className="text-sm text-signal">{label}</span>
        {hint && <span className="block text-xs text-signal-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function OwnerBansPanel() {
  const [onlyAppeals, setOnlyAppeals] = useState(false);
  const { data: bans, isLoading } = useOwnerBans(onlyAppeals);
  const resolveAppeal = useResolveAppeal();
  const liftBan = useLiftBan();
  const [responseFor, setResponseFor] = useState<string | null>(null);
  const [response, setResponse] = useState("");

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm text-signal-dim">
        <input
          type="checkbox"
          checked={onlyAppeals}
          onChange={(e) => setOnlyAppeals(e.target.checked)}
          className="accent-[var(--accent)]"
        />
        Only show pending appeals
      </label>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
        </div>
      ) : !bans || bans.length === 0 ? (
        <p className="py-10 text-center text-signal-dim">
          {onlyAppeals ? "No appeals waiting." : "No bans have been issued."}
        </p>
      ) : (
        <div className="space-y-3">
          {bans.map((b) => (
            <div key={b.id} className="rounded-lg border border-hairline bg-base-800 p-3">
              <div className="flex items-start gap-3">
                <UserAvatar
                  avatarUrl={b.user?.avatarUrl ?? null}
                  name={b.user?.displayName ?? b.user?.username ?? "?"}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-signal">
                    {b.user?.displayName ?? b.user?.username ?? "[deleted user]"}
                    {b.liftedAt && <span className="ml-2 text-xs text-pulse">lifted</span>}
                  </p>
                  <p className="text-xs text-signal-faint">
                    {new Date(b.createdAt).toLocaleString()} ·{" "}
                    {b.expiresAt ? `expires ${new Date(b.expiresAt).toLocaleDateString()}` : "permanent"} ·{" "}
                    {b.identifierCount} identifier{b.identifierCount === 1 ? "" : "s"}
                  </p>
                  <p className="mt-1 text-sm text-signal-dim">{b.reason}</p>

                  {b.appealStatus === "PENDING" && b.appealText && (
                    <div className="mt-2 rounded-lg border border-amber/40 bg-base-900 p-2">
                      <p className="text-xs uppercase tracking-wide text-amber">Appeal</p>
                      <p className="mt-1 text-sm text-signal">{b.appealText}</p>
                    </div>
                  )}
                  {b.appealStatus === "DENIED" && (
                    <p className="mt-1 text-xs text-signal-faint">Appeal denied: {b.appealResponse}</p>
                  )}
                  {b.appealStatus === "APPROVED" && (
                    <p className="mt-1 text-xs text-pulse">Appeal approved: {b.appealResponse}</p>
                  )}
                </div>

                {!b.liftedAt && (
                  <button
                    type="button"
                    onClick={() => liftBan.mutate({ groupId: b.groupId })}
                    className="rounded-lg bg-base-600 px-2 py-1 text-xs text-signal"
                  >
                    Lift ban
                  </button>
                )}
              </div>

              {b.appealStatus === "PENDING" && (
                <div className="mt-3 space-y-2 border-t border-hairline pt-3">
                  {responseFor === b.groupId ? (
                    <>
                      <input
                        value={response}
                        onChange={(e) => setResponse(e.target.value.slice(0, 500))}
                        placeholder="Your response to the appeal (they will see this)"
                        className="w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={!response.trim()}
                          onClick={() => {
                            resolveAppeal.mutate({ groupId: b.groupId, approve: true, response: response.trim() });
                            setResponseFor(null);
                            setResponse("");
                          }}
                          className="rounded-lg bg-pulse px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
                        >
                          Approve &amp; unban
                        </button>
                        <button
                          type="button"
                          disabled={!response.trim()}
                          onClick={() => {
                            resolveAppeal.mutate({ groupId: b.groupId, approve: false, response: response.trim() });
                            setResponseFor(null);
                            setResponse("");
                          }}
                          className="rounded-lg bg-base-600 px-3 py-1.5 text-sm text-signal disabled:opacity-50"
                        >
                          Deny
                        </button>
                        <button
                          type="button"
                          onClick={() => setResponseFor(null)}
                          className="rounded-lg px-3 py-1.5 text-sm text-signal-faint"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setResponseFor(b.groupId)}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
                    >
                      Respond to appeal
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
