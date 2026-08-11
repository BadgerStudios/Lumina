import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateServer } from "../../queries/servers";

export function CreateServerModal() {
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const createServer = useCreateServer();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  const open = openModal === "createServer";

  async function handleCreate() {
    if (!name.trim()) return;
    const server = await createServer.mutateAsync({ name: name.trim() });
    setName("");
    closeModal();
    closeMobileDrawer();
    if (server.systemChannelId) navigate(`/channels/${server.id}/${server.systemChannelId}`);
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title="Create a Server">
      <p className="mb-4 text-sm text-signal-dim">Give your new server a name. You can change this later.</p>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold uppercase text-signal-dim">Server name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleCreate()}
          className="rounded bg-base-900 px-3 py-2.5 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          placeholder="My awesome server"
        />
      </label>
      <div className="mt-5 flex justify-end gap-3">
        <button onClick={closeModal} className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline">
          Cancel
        </button>
        <button
          onClick={() => void handleCreate()}
          disabled={!name.trim() || createServer.isPending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </Modal>
  );
}
