import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateInvite, useInvites, useRevokeInvite } from "../../queries/invites";

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

  function inviteUrl(code: string) {
    return `${window.location.origin}/invite/${code}`;
  }

  async function copy(code: string) {
    await navigator.clipboard.writeText(inviteUrl(code));
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Invite Friends">
      <button
        onClick={() => createInvite.mutate({})}
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
