import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateInvite, useInvites, useRevokeInvite } from "../../queries/invites";
import { PUBLIC_ORIGIN } from "../../lib/platform";

export function InviteModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "invite" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";

  const { data: invites } = useInvites(open ? serverId : undefined);
  const createInvite = useCreateInvite(serverId);
  const revokeInvite = useRevokeInvite(serverId);
  const [copied, setCopied] = useState<string | null>(null);
  // "0" is the no-limit / never default, which is what the bare mutate({}) used to send.
  const [maxUses, setMaxUses] = useState("0");
  const [expiresIn, setExpiresIn] = useState("0");

  function generate() {
    createInvite.mutate({
      maxUses: maxUses === "0" ? null : Number(maxUses),
      expiresInSeconds: expiresIn === "0" ? null : Number(expiresIn),
    });
  }

  const selectCls =
    "rounded border border-hairline bg-base-900 px-2 py-1.5 text-sm text-signal focus:border-accent focus:outline-none";

  function inviteUrl(code: string) {
    return `${PUBLIC_ORIGIN}/invite/${code}`;
  }

  async function copy(code: string) {
    await navigator.clipboard.writeText(inviteUrl(code));
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Invite Friends">
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
        onClick={generate}
        disabled={createInvite.isPending}
        className="mb-4 w-full rounded bg-accent py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
      >
        Generate new invite link
      </button>

      <div className="flex flex-col gap-2">
        {invites?.length ? (
          invites.map((invite) => (
            <div key={invite.code} className="flex items-center justify-between gap-2 rounded bg-base-900 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate text-signal">{inviteUrl(invite.code)}</div>
                <div className="text-xs text-signal-faint">
                  {invite.uses} use{invite.uses === 1 ? "" : "s"}
                  {invite.maxUses ? ` / ${invite.maxUses} max` : ""}
                  {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => copy(invite.code)} className="text-signal-dim hover:text-signal">
                  {copied === invite.code ? <Check size={16} className="text-online" /> : <Copy size={16} />}
                </button>
                <button
                  onClick={() => revokeInvite.mutate(invite.code)}
                  className="text-xs text-dnd hover:underline"
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-signal-faint">No active invites yet.</p>
        )}
      </div>
    </Modal>
  );
}
