import { useState } from "react";
import { Send } from "lucide-react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useDMs } from "../../queries/dms";
import { useServers } from "../../queries/servers";
import { useChannels } from "../../queries/channels";
import { useAuthStore } from "../../store/authStore";
import { api } from "../../lib/apiClient";
import { reportError, toast } from "../../store/toastStore";

/** Forward a message into another DM or channel. Re-sends the text with an attribution line via the
 * normal message endpoints (so slowmode, mentions, everything downstream behaves exactly as a typed
 * message would). Attachments can't ride along yet — the send endpoints take freshly-uploaded files,
 * not references — so their count is noted in the forwarded text. */
export function ForwardModal() {
  const openModal = useUIStore((s) => s.openModal);
  const payload = useUIStore((s) => s.modalPayload) as
    | { content: string; authorLabel: string; attachmentCount: number }
    | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "forward" && !!payload;

  const me = useAuthStore((s) => s.user);
  const { data: dms } = useDMs();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<string>("");
  const { data: channels } = useChannels(open && serverId ? serverId : undefined);
  const [sending, setSending] = useState<string | null>(null);

  function forwardText(): string {
    if (!payload) return "";
    const head = `> Forwarded from ${payload.authorLabel}:`;
    const body = payload.content?.trim() ? payload.content : "(no text)";
    const attach = payload.attachmentCount > 0 ? `\n> (${payload.attachmentCount} attachment(s) on the original)` : "";
    return `${head}\n${body}${attach}`;
  }

  async function forwardTo(kind: "dm" | "channel", id: string, label: string) {
    if (sending) return;
    setSending(id);
    try {
      const path = kind === "dm" ? `/dm/${id}/messages` : `/channels/${id}/messages`;
      await api.post(path, { content: forwardText() });
      toast.success(`Forwarded to ${label}.`);
      closeModal();
    } catch (e) {
      reportError(e, "Couldn't forward that message.");
    } finally {
      setSending(null);
    }
  }

  const row = "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-signal hover:bg-base-700 disabled:opacity-60";

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Forward message">
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-signal-faint">Direct messages</div>
          {dms && dms.length > 0 ? (
            dms.map((c) => {
              const other = c.participants.find((p) => p.id !== me?.id) ?? c.participants[0];
              const label = c.isGroup ? c.name ?? c.participants.map((p) => p.displayName ?? p.username).join(", ") : other?.displayName ?? other?.username ?? "Direct message";
              return (
                <button key={c.id} className={row} disabled={!!sending} onClick={() => forwardTo("dm", c.id, label)}>
                  <span className="truncate">{label}</span>
                  <Send size={14} className="shrink-0 text-signal-faint" />
                </button>
              );
            })
          ) : (
            <div className="px-2 py-1 text-sm text-signal-faint">No direct messages.</div>
          )}
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-signal-faint">Server channel</div>
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="mb-1 w-full rounded bg-base-900 px-2 py-1.5 text-sm text-signal outline-none"
          >
            <option value="">Pick a server…</option>
            {servers?.map((sv) => (
              <option key={sv.id} value={sv.id}>
                {sv.name}
              </option>
            ))}
          </select>
          {serverId
            ? (channels ?? [])
                .filter((ch) => ch.type === "TEXT")
                .map((ch) => (
                  <button key={ch.id} className={row} disabled={!!sending} onClick={() => forwardTo("channel", ch.id, `#${ch.name}`)}>
                    <span className="truncate">#{ch.name}</span>
                    <Send size={14} className="shrink-0 text-signal-faint" />
                  </button>
                ))
            : null}
        </div>
      </div>
    </Modal>
  );
}
