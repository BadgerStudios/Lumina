import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateChannel } from "../../queries/channels";

export function CreateChannelModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as
    | { serverId: string; parentId?: string | null; initialType?: "TEXT" | "CATEGORY" | "VOICE" }
    | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<"TEXT" | "CATEGORY" | "VOICE">("TEXT");

  const open = openModal === "createChannel" && !!modalPayload;
  const createChannel = useCreateChannel(modalPayload?.serverId ?? "");

  // Preselect the type the opener asked for (e.g. the "Create Category" menu item passes CATEGORY),
  // and reset the form each time the modal opens so a stale type/name from a prior open never leaks in.
  useEffect(() => {
    if (open) {
      setType(modalPayload?.initialType ?? "TEXT");
      setName("");
    }
  }, [open, modalPayload?.initialType]);

  async function handleCreate() {
    if (!name.trim() || !modalPayload) return;
    const channel = await createChannel.mutateAsync({
      name: name.trim().toLowerCase().replace(/\s+/g, "-"),
      type,
      parentId: modalPayload.parentId ?? null,
    });
    setName("");
    closeModal();
    closeMobileDrawer();
    if (channel.type === "TEXT") navigate(`/channels/${modalPayload.serverId}/${channel.id}`);
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title={type === "CATEGORY" ? "Create Category" : "Create Channel"}>
      <div className="mb-4 flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={type === "TEXT"} onChange={() => setType("TEXT")} /> Text
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={type === "CATEGORY"} onChange={() => setType("CATEGORY")} /> Category
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={type === "VOICE"} onChange={() => setType("VOICE")} /> Voice
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Channel name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          className="rounded bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          placeholder="new-channel"
        />
      </label>
      <div className="mt-5 flex justify-end gap-3">
        <button onClick={closeModal} className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline">
          Cancel
        </button>
        <button
          onClick={() => void handleCreate()}
          disabled={!name.trim() || createChannel.isPending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {type === "CATEGORY" ? "Create Category" : "Create Channel"}
        </button>
      </div>
    </Modal>
  );
}
