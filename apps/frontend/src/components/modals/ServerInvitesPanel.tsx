import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useCreateInvite, useInvites, useRevokeInvite } from "../../queries/invites";
import { useMembers } from "../../queries/members";
import { PUBLIC_ORIGIN } from "../../lib/platform";

/**
 * Invites, as a settings section: every live link into the space, who made it, how far it has
 * gone, and a way to pull it. The chat-side "Invite people" modal makes a link in a hurry; this
 * is where an admin audits the ones that exist.
 */
export function ServerInvitesPanel({ serverId }: { serverId: string }) {
  const { data: invites } = useInvites(serverId);
  const { data: members } = useMembers(serverId);
  const createInvite = useCreateInvite(serverId);
  const revokeInvite = useRevokeInvite(serverId);
  const [copied, setCopied] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("0");
  const [expiresIn, setExpiresIn] = useState("0");

  const nameOf = (userId: string) => {
    const m = members?.find((x) => x.userId === userId);
    return m ? (m.nickname ?? m.user.displayName ?? m.user.username) : "someone who has since left";
  };
  const inviteUrl = (code: string) => `${PUBLIC_ORIGIN}/invite/${code}`;
  async function copy(code: string) {
    await navigator.clipboard.writeText(inviteUrl(code));
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  }
  const selectCls = "rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-hairline bg-base-800/40 p-4">
        <h3 className="mb-3 text-sm font-semibold text-signal">New invite link</h3>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-signal-faint">
            Max uses
            <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)} className={selectCls}>
              <option value="0">No limit</option>
              <option value="1">1 use</option>
              <option value="5">5 uses</option>
              <option value="10">10 uses</option>
              <option value="25">25 uses</option>
              <option value="50">50 uses</option>
              <option value="100">100 uses</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-signal-faint">
            Expire after
            <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} className={selectCls}>
              <option value="0">Never</option>
              <option value="1800">30 minutes</option>
              <option value="3600">1 hour</option>
              <option value="21600">6 hours</option>
              <option value="43200">12 hours</option>
              <option value="86400">1 day</option>
              <option value="604800">7 days</option>
            </select>
          </label>
        </div>
        <button
          onClick={() =>
            createInvite.mutate({
              maxUses: maxUses === "0" ? null : Number(maxUses),
              expiresInSeconds: expiresIn === "0" ? null : Number(expiresIn),
            })
          }
          disabled={createInvite.isPending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Create invite link
        </button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-signal">
          Active invites{invites ? ` (${invites.length})` : ""}
        </h3>
        {invites?.length ? (
          <ul className="flex flex-col gap-1">
            {invites.map((invite) => {
              const expired = !!invite.expiresAt && new Date(invite.expiresAt) < new Date();
              return (
                <li key={invite.code} className="flex items-center justify-between gap-3 rounded-lg bg-base-900 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm text-signal">{inviteUrl(invite.code)}</div>
                    <div className="text-xs text-signal-faint">
                      by {nameOf(invite.creatorId)} · {invite.uses} use{invite.uses === 1 ? "" : "s"}
                      {invite.maxUses ? ` of ${invite.maxUses}` : ""}
                      {invite.expiresAt ? ` · ${expired ? "expired" : "expires"} ${new Date(invite.expiresAt).toLocaleString()}` : " · never expires"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button onClick={() => copy(invite.code)} className="text-signal-dim hover:text-signal" aria-label="Copy invite link">
                      {copied === invite.code ? <Check size={16} className="text-online" /> : <Copy size={16} />}
                    </button>
                    <button onClick={() => revokeInvite.mutate(invite.code)} className="text-xs text-dnd hover:underline">
                      Revoke
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-signal-faint">No active invites. Anyone who has a link needs one that exists here.</p>
        )}
      </section>
    </div>
  );
}
