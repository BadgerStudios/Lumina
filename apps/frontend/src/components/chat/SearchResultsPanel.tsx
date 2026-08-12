import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import type { MessageDTO } from "@lumina/shared";
import { useSearch } from "../../queries/search";
import { useChannels } from "../../queries/channels";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Results for the search box in the channel header.
 *
 * The backend route, the Postgres full-text index (`message_search_idx`) and the `useSearch` hook
 * all existed and were fully working — and nothing rendered the search box at all, because nothing
 * ever passed `onSearch` down to it. Everything up to the last mile was built. This is the last
 * mile, and it is the third time this exact gap has been found in this codebase.
 *
 * Deliberately mirrors PinnedMessagesPanel: same anchored panel, same shape, so the two things you
 * can open from the header behave identically rather than being two people's idea of a panel.
 */
export function SearchResultsPanel({
  serverId,
  query,
  onClose,
}: {
  serverId: string;
  query: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data: results, isLoading } = useSearch(serverId, query);
  const { data: channels } = useChannels(serverId);
  const channelName = (id: string | null) => channels?.find((c) => c.id === id)?.name ?? "unknown";

  return (
    <div className="absolute right-3 top-14 z-20 flex max-h-[calc(var(--app-height-safe)*0.70)] w-96 flex-col overflow-hidden rounded-lg border border-base-500 bg-base-800 shadow-2xl">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-base-900/60 px-3 py-2.5 text-sm font-semibold text-signal">
        <Search size={15} className="text-accent" />
        Results for “{query}”
        <button onClick={onClose} className="ml-auto text-signal-dim hover:text-signal" aria-label="Close search results">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <p className="px-2 py-4 text-center text-sm text-signal-faint">Searching…</p>
        ) : results && results.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {results.map((m: MessageDTO) => (
              <button
                key={m.id}
                type="button"
                // Opens the channel the hit is in. Scrolling to the exact message would need
                // anchored pagination the message list doesn't have yet — landing in the right
                // channel is honest and useful; pretending to jump and silently not would not be.
                onClick={() => {
                  if (m.channelId) navigate(`/channels/${serverId}/${m.channelId}`);
                  onClose();
                }}
                className="group rounded-lg px-2 py-2 text-left hover:bg-base-600"
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-signal">
                    {m.author?.displayName ?? m.author?.username ?? "Unknown"}
                  </span>
                  <span className="text-[10px] text-signal-faint">
                    #{channelName(m.channelId)} · {formatTime(m.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-signal-dim">
                  {m.content}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-2 py-4 text-center text-sm text-signal-faint">
            Nothing matched “{query}” in this server.
          </p>
        )}
      </div>
    </div>
  );
}
