import { Pin, PinOff, X } from "lucide-react";
import type { MessageDTO } from "@lumina/shared";
import { usePinnedMessages, useTogglePinMessage } from "../../queries/messages";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Opened from the Pin button in TopBar.tsx. `pinned` was already a MessageDTO field and
 * GET /channels/:id/pins already existed server-side with zero UI consuming it before this. */
export function PinnedMessagesPanel({
  channelId,
  canManage,
  onClose,
}: {
  channelId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const { data: pins, isLoading } = usePinnedMessages(channelId, true);
  const togglePin = useTogglePinMessage();

  return (
    <div className="absolute right-3 top-14 z-20 flex max-h-[calc(var(--app-height-safe)*0.70)] w-80 flex-col overflow-hidden rounded-lg border border-base-500 bg-base-800 shadow-2xl">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-base-900/60 px-3 py-2.5 text-sm font-semibold text-signal">
        <Pin size={15} className="text-accent" /> Pinned Messages
        <button onClick={onClose} className="ml-auto text-signal-dim hover:text-signal">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <p className="px-2 py-4 text-center text-sm text-signal-faint">Loading…</p>
        ) : pins && pins.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {pins.map((m: MessageDTO) => (
              <div key={m.id} className="group rounded-lg px-2 py-2 hover:bg-base-600">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-signal">{m.author?.displayName ?? m.author?.username ?? "Unknown"}</span>
                  <span className="text-[10px] text-signal-faint">{formatTime(m.createdAt)}</span>
                  {canManage && (
                    <button
                      onClick={() => togglePin.mutate({ messageId: m.id, pinned: false })}
                      className="ml-auto shrink-0 text-signal-faint opacity-0 hover:text-dnd group-hover:opacity-100"
                      title="Unpin"
                    >
                      <PinOff size={13} />
                    </button>
                  )}
                </div>
                <p className="truncate text-sm text-signal-dim">{m.content || "(attachment)"}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-2 py-4 text-center text-sm text-signal-faint">No pinned messages in this channel yet.</p>
        )}
      </div>
    </div>
  );
}
