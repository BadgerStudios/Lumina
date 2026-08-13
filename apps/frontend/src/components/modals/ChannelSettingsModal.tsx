import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useUIStore } from "../../store/uiStore";
import { useChannels, useUpdateChannel, useDeleteChannel } from "../../queries/channels";
import { ChannelPermissionsPanel } from "./ChannelPermissionsPanel";
import { cn } from "../../lib/cn";

// Discord's own slowmode preset ladder — 0 means off.
const SLOWMODE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "Off", seconds: 0 },
  { label: "5s", seconds: 5 },
  { label: "10s", seconds: 10 },
  { label: "15s", seconds: 15 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "2m", seconds: 120 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
  { label: "15m", seconds: 900 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
  { label: "2h", seconds: 7200 },
  { label: "6h", seconds: 21600 },
];

/** Was a genuine gap, not just a hidden feature: useUpdateChannel/useDeleteChannel
 * (queries/channels.ts) had existed since channels were first built, fully working
 * server-side, with zero UI ever calling them — a channel could be created but never renamed,
 * re-topic'd, or deleted again without going straight to the API. Mirrors RoleEditorModal.tsx's
 * shape (same persistent-singleton pattern, same open+id-keyed useEffect resync). */
export function ChannelSettingsModal() {
  const openModal = useUIStore((s) => s.openModal);
  const modalPayload = useUIStore((s) => s.modalPayload) as { serverId: string; channelId: string } | undefined;
  const closeModal = useUIStore((s) => s.closeModal);
  const open = openModal === "channelSettings" && !!modalPayload;
  const serverId = modalPayload?.serverId ?? "";
  const channelId = modalPayload?.channelId ?? "";

  const { data: channels } = useChannels(open ? serverId : undefined);
  const channel = channels?.find((c) => c.id === channelId);
  const updateChannel = useUpdateChannel(serverId);
  const deleteChannel = useDeleteChannel(serverId);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [slowmodeSeconds, setSlowmodeSeconds] = useState(0);
  const [nsfw, setNsfw] = useState(false);
  const [tab, setTab] = useState<"overview" | "permissions">("overview");
  const [parentId, setParentId] = useState<string | null>(null);

  // Categories a channel can be filed under. A category cannot be nested inside another, and a
  // channel obviously cannot be its own parent.
  const categories = (channels ?? []).filter((c) => c.type === "CATEGORY" && c.id !== channelId);

  useEffect(() => {
    if (open && channel) {
      setTab("overview");
      setName(channel.name);
      setTopic(channel.topic ?? "");
      setSlowmodeSeconds(channel.slowmodeSeconds);
      setNsfw(channel.nsfw);
      setParentId(channel.parentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channelId, channel?.name, channel?.topic, channel?.slowmodeSeconds, channel?.nsfw, channel?.parentId]);

  async function handleSave() {
    if (!name.trim()) return;
    await updateChannel.mutateAsync({
      channelId,
      name: name.trim(),
      topic: topic.trim() || null,
      slowmodeSeconds,
      // Sent for every non-category channel, including when cleared back to null — omitting it
      // when null would make "move out of a category" impossible to express.
      ...(channel?.type !== "CATEGORY" ? { parentId } : {}),
      ...(channel?.type === "TEXT" ? { nsfw } : {}),
    });
    closeModal();
  }

  async function handleDelete() {
    if (!channel) return;
    if (!confirm(`Delete #${channel.name}? This cannot be undone.`)) return;
    await deleteChannel.mutateAsync(channelId);
    closeModal();
  }

  return (
    <Modal open={open} onOpenChange={(o) => !o && closeModal()} title={channel ? `#${channel.name} Settings` : "Channel Settings"} width="max-w-lg">
      <div className="mb-4 flex gap-1 border-b border-base-700">
        {(["overview", "permissions"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
              tab === t ? "border-accent text-signal" : "border-transparent text-signal-dim hover:text-signal",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "permissions" ? (
        <ChannelPermissionsPanel serverId={serverId} channelId={channelId} />
      ) : (
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-bold uppercase text-signal-dim">Channel name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
        </label>

        {channel?.type !== "CATEGORY" && categories.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase text-signal-dim">Category</span>
            {/* Categories could be created and were rendered as sidebar groups, but nothing could
                ever be put in one — the API took `parentId` and no screen offered it. A category
                you cannot file anything under is just an empty heading. */}
            <select
              aria-label="Category"
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value || null)}
              className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {channel?.type === "TEXT" && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase text-signal-dim">Topic</span>
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                rows={2}
                maxLength={1024}
                className="resize-none rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              />
            </label>

            <div>
              <span className="text-xs font-bold uppercase text-signal-dim">Slow mode</span>
              <p className="mb-2 text-sm text-signal-faint">
                Members must wait between messages. Moderators (Manage Messages) are exempt.
              </p>
              <select
                aria-label="Slow mode delay"
                value={slowmodeSeconds}
                onChange={(e) => setSlowmodeSeconds(Number(e.target.value))}
                className="rounded bg-base-900 px-3 py-2 text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
              >
                {SLOWMODE_PRESETS.map((p) => (
                  <option key={p.seconds} value={p.seconds}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm text-signal-dim">
              <input type="checkbox" checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} />
              Age-restricted / NSFW channel
            </label>
          </>
        )}
      </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button onClick={() => void handleDelete()} className="text-sm text-dnd hover:underline">
          Delete channel
        </button>
        <div className="flex gap-3">
          <button onClick={closeModal} className="rounded px-4 py-2 text-sm font-medium text-signal-dim hover:underline">
            {/* Permission edits save on click, so there is nothing pending to discard on that tab
                and "Cancel" would be a lie about what closing does. */}
            {tab === "permissions" ? "Close" : "Cancel"}
          </button>
          {tab === "overview" && (
            <button
              onClick={() => void handleSave()}
              disabled={updateChannel.isPending || !name.trim()}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
