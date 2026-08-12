import { Loader2, X, Monitor, Globe, Shield, MessageSquare, Video, Server as ServerIcon } from "lucide-react";
import { useOwnerUserDetail } from "../queries/owner";
import { UserAvatar } from "../components/common/UserAvatar";

/**
 * Everything known about one account, in one place.
 *
 * `GET /owner/users/:id` has returned all of this since the day it was written — message and video
 * counts, every server they're in, their full ban history including who issued each one, and their
 * live sessions with IP and device — and **nothing in the app ever rendered a single field of it**.
 * The owner console could list people and ban them, but never look at one, which is the half of the
 * job that actually informs the decision.
 *
 * The sessions table is the point of this panel. Ban evasion is judged by whether a new account
 * shares an IP or a device with a banned one, and that comparison is impossible if the numbers are
 * only ever in the database.
 */
export function OwnerUserDetailPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { data, isLoading, error } = useOwnerUserDetail(userId);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6">
      <div
        className="flex max-h-[calc(var(--app-height-safe)*0.90)] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-hairline bg-base-800 sm:rounded-2xl"
        // Bottom-anchored on a phone and centred on a desktop: the owner console is used on both,
        // and a centred sheet on a 390px screen wastes the half of the height a thumb can reach.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate font-display text-base text-signal">
            {data ? `@${data.username}` : "Account"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-signal-faint hover:text-signal">
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-signal-dim">
              <Loader2 size={15} className="animate-spin" /> Loading…
            </div>
          )}
          {error && <p className="text-sm text-dnd">Couldn't load this account.</p>}

          {data && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <UserAvatar avatarUrl={data.avatarUrl} name={data.displayName ?? data.username} size={48} />
                <div className="min-w-0">
                  <p className="truncate font-medium text-signal">{data.displayName ?? data.username}</p>
                  <p className="truncate text-xs text-signal-faint">{data.email}</p>
                  <p className="text-xs text-signal-faint">
                    {data.platformRole} · joined {new Date(data.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat icon={MessageSquare} label="Messages" value={data.counts.messages} />
                <Stat icon={Video} label="Videos" value={data.counts.videos} />
                <Stat icon={ServerIcon} label="Servers" value={data.counts.servers} />
                <Stat icon={Shield} label="Owns" value={data.counts.ownedServers} />
              </div>

              <Section title={`Sessions (${data.sessions.length})`}>
                {data.sessions.length === 0 ? (
                  <p className="text-xs text-signal-faint">No active sessions.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.sessions.map((s) => (
                      <div key={s.id} className="rounded-lg border border-hairline bg-base-900 p-2 text-xs">
                        <div className="flex items-center gap-2 text-signal">
                          <Globe size={12} className="shrink-0 text-signal-faint" />
                          {/* Selectable: the whole reason to show an IP is to compare it against
                              another account's, which means copying it. */}
                          <span className="select-all font-mono">{s.ipAddress ?? "unknown"}</span>
                          <span className="ml-auto shrink-0 text-signal-faint">
                            {new Date(s.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="mt-1 flex items-start gap-2 text-signal-faint">
                          <Monitor size={12} className="mt-0.5 shrink-0" />
                          <span className="break-all">{s.userAgent ?? "unknown device"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title={`Ban history (${data.bans.length})`}>
                {data.bans.length === 0 ? (
                  <p className="text-xs text-signal-faint">Never banned.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.bans.map((b) => (
                      <div key={b.id} className="rounded-lg border border-hairline bg-base-900 p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded bg-base-700 px-1.5 py-0.5 text-[11px] text-signal">{b.scope}</span>
                          {/* Lifted bans stay visible rather than being filtered out: a pattern of
                              repeated bans and lifts is exactly what an owner needs to see. */}
                          {b.liftedAt && <span className="text-online">lifted</span>}
                          {!b.liftedAt && !b.expiresAt && <span className="text-dnd">permanent</span>}
                          {!b.liftedAt && b.expiresAt && (
                            <span className="text-flare">until {new Date(b.expiresAt).toLocaleDateString()}</span>
                          )}
                          <span className="ml-auto text-signal-faint">
                            {new Date(b.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="mt-1 text-signal">{b.reason}</p>
                        {b.bannedBy && (
                          <p className="mt-0.5 text-signal-faint">by @{b.bannedBy.username}</p>
                        )}
                        {b.appealText && (
                          <p className="mt-1 border-l-2 border-hairline pl-2 text-signal-dim">
                            Appeal: {b.appealText}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title={`Servers (${data.servers.length})`}>
                {data.servers.length === 0 ? (
                  <p className="text-xs text-signal-faint">Not in any server.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {data.servers.map((s) => (
                      <span key={s.id} className="rounded-lg bg-base-700 px-2 py-1 text-xs text-signal">
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Shield; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline bg-base-900 p-2">
      <div className="flex items-center gap-1.5 text-signal-faint">
        <Icon size={12} />
        <span className="text-[11px] uppercase">{label}</span>
      </div>
      <p className="mt-0.5 font-display text-lg text-signal">{value.toLocaleString()}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-bold uppercase text-signal-dim">{title}</h3>
      {children}
    </div>
  );
}
