import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useCreateChannel } from "../../queries/channels";

type ChannelKind = "TEXT" | "ANNOUNCEMENT" | "FORUM" | "VOICE" | "STAGE" | "CATEGORY";

// Order shown in the picker; text first, structural (category) last.
const CHANNEL_KINDS: { value: ChannelKind; label: string; hint: string }[] = [
  { value: "TEXT", label: "Text", hint: "Send messages, images, and files" },
  { value: "ANNOUNCEMENT", label: "Announcement", hint: "Only moderators post; everyone reads" },
  { value: "FORUM", label: "Forum", hint: "Threaded posts, like a message board" },
  { value: "VOICE", label: "Voice", hint: "Talk and share video" },
  { value: "STAGE", label: "Stage", hint: "Moderated audio: speakers present, an audience listens" },
  { value: "CATEGORY", label: "Category", hint: "A collapsible group of channels" },
];

export function CreateChannelModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as
    | { serverId: string; parentId?: string | null; initialType?: ChannelKind }
    | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const closeMobileDrawer = useUIStore((s) => s.closeMobileDrawer);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelKind>("TEXT");

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
    // Everything with a channel view (not a category or a voice room) opens on create.
    if (
      channel.type === "TEXT" ||
      channel.type === "ANNOUNCEMENT" ||
      channel.type === "FORUM" ||
      channel.type === "STAGE"
    ) {
      navigate(`/channels/${modalPayload.serverId}/${channel.id}`);
    }
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title={type === "CATEGORY" ? "Create Category" : "Create Channel"}>
      <div className="mb-4 flex flex-col gap-1.5">
        {CHANNEL_KINDS.map((k) => (
          <label
            key={k.value}
            className={
              "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm " +
              (type === k.value
                ? "border-accent bg-accent/10"
                : "border-hairline hover:border-signal-faint")
            }
          >
            <input
              type="radio"
              className="mt-0.5"
              checked={type === k.value}
              onChange={() => setType(k.value)}
            />
            <span className="flex flex-col">
              <span className="font-medium text-signal">{k.label}</span>
              <span className="text-xs text-signal-faint">{k.hint}</span>
            </span>
          </label>
        ))}
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
