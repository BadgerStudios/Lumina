import { useEffect, useState } from "react";
import { X, UserMinus } from "lucide-react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useDMs, useRenameDM, useAddDMParticipant, useRemoveDMParticipant } from "../../queries/dms";
import { UserAvatar } from "../common/UserAvatar";
import { UserSearchInput } from "../common/UserSearchInput";
import { ApiError } from "../../lib/apiClient";

/** Group DM management — rename + add/remove participants. Both backend routes (PATCH /dm/:id,
 * POST/DELETE /dm/:id/participants) previously didn't exist at all: a group could be created
 * but never adjusted afterward. Follows the same persistent-singleton + open/id-keyed useEffect
 * resync pattern as ChannelSettingsModal.tsx/RoleEditorModal.tsx. */
export function GroupDMSettingsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { conversationId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "groupDMSettings" && !!modalPayload;
  const conversationId = modalPayload?.conversationId ?? "";

  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data: conversations } = useDMs();
  const conversation = conversations?.find((c) => c.id === conversationId);

  const renameDM = useRenameDM();
  const addParticipant = useAddDMParticipant(conversationId);
  const removeParticipant = useRemoveDMParticipant(conversationId);

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setName(conversation?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId, conversation?.name]);

  const participantIds = new Set(conversation?.participants.map((p) => p.id) ?? []);

  async function handleRename() {
    setError(null);
    try {
      await renameDM.mutateAsync({ conversationId, name: name.trim() || null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to rename");
    }
  }

  async function handleAdd(userId: string) {
    setError(null);
    try {
      await addParticipant.mutateAsync(userId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add participant");
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeParticipant.mutateAsync(userId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to remove participant");
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Group DM Settings" width="max-w-lg">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold uppercase text-signal-dim">Group name</span>
          {/* A form, so Enter in the name field saves — previously only the Save button's click did. */}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!renameDM.isPending) void handleRename(); }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Unnamed group"
              className="min-w-0 flex-1 rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={renameDM.isPending}
              className="rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Save
            </button>
          </form>
        </label>

        <div>
          <span className="text-xs font-bold uppercase text-signal-dim">
            Members — {conversation?.participants.length ?? 0}
          </span>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {(conversation?.participants ?? []).map((p) => (
              <div key={p.id} className="flex items-center gap-2.5 rounded px-2 py-1.5 hover:bg-base-700">
                <UserAvatar avatarUrl={p.avatarUrl} name={p.displayName ?? p.username} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm text-signal">{p.displayName ?? p.username}</span>
                {p.id !== currentUserId && (
                  <button
                    onClick={() => void handleRemove(p.id)}
                    className="shrink-0 rounded p-1 text-signal-faint hover:bg-base-500 hover:text-dnd"
                    title="Remove from group"
                  >
                    <UserMinus size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <span className="text-xs font-bold uppercase text-signal-dim">Add someone</span>
          {/* Searches everyone rather than only listing friends — you can be in a group with people
              you haven't friended, and the old friends-only list made those impossible to add. */}
          <div className="mt-1.5">
            <UserSearchInput
              placeholder="Search for people…"
              excludeIds={Array.from(participantIds)}
              limit={6}
              onSelect={(u) => void handleAdd(u.id)}
            />
          </div>
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded bg-base-900 px-3 py-2 text-sm text-dnd">
            <X size={14} className="shrink-0" />
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
