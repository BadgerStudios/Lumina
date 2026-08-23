import { PinOff } from "lucide-react";
import type { MessageDTO } from "@lumina/shared";
import { usePinnedMessages, useTogglePinMessage } from "../../queries/messages";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The pinned messages of one room.
 *
 * Content only — this used to be a floating popover that positioned itself against the old header
 * bar (`absolute right-3 top-14`), which meant it covered the top of the conversation and had to
 * be dismissed before you could read anything. It is now the "Pinned" tab of the contextual aside
 * (see layout/AsidePanel.tsx), which can stay open beside the messages instead of on top of them.
 */
export function PinnedList({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const { data: pins, isLoading } = usePinnedMessages(channelId, true);
  const togglePin = useTogglePinMessage();

  if (isLoading) return <p className="px-3 py-4 text-center text-sm text-signal-faint">Loading…</p>;
  if (!pins || pins.length === 0) {
    return <p className="px-3 py-4 text-center text-sm text-signal-faint">Nothing pinned in this room yet.</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="flex flex-col gap-0.5">
        {pins.map((m: MessageDTO) => (
          <div key={m.id} className="group rounded-lg px-2 py-2 hover:bg-base-600">
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-sm font-semibold text-signal">
                {m.author?.displayName ?? m.author?.username ?? "Unknown"}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-signal-faint">{formatTime(m.createdAt)}</span>
              {canManage && (
                <button
                  onClick={() => togglePin.mutate({ messageId: m.id, pinned: false })}
                  className="ml-auto hidden shrink-0 text-signal-faint hover:text-flare group-hover:block max-md:block"
                  title="Unpin"
                  aria-label="Unpin"
                >
                  <PinOff size={13} />
                </button>
              )}
            </div>
            <p className="line-clamp-3 text-sm text-signal-dim">{m.content || "(attachment)"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
