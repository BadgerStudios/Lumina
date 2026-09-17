import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ImagePlay } from "lucide-react";
import type { GifItemDTO } from "@lumina/shared";
import { Tooltip } from "../common/Tooltip";
import { ICON } from "../common/Icon";
import { useGifFeed } from "../../queries/gifs";
import { ApiError, attachmentUrl } from "../../lib/apiClient";

/**
 * GIF picker for the composer: trending on open, KLIPY search as you type, more as you scroll.
 * Picking one sends it straight away (like a sticker) — the backend stores it as an attachment.
 *
 * KLIPY's terms require "Search KLIPY" as the search box placeholder, so it says exactly that.
 * Previews come from our own /api/gifs/media proxy, never from KLIPY directly.
 */
export function GifPicker({ onPick, disabled }: { onPick: (gif: GifItemDTO, query: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Search once typing pauses, so a word is one request rather than one per letter.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const feed = useGifFeed(query, open);
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  // Load the next page when the bottom of the grid scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!open || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage, items.length]);

  // Two columns, each GIF placed in the shorter one, so tall and wide GIFs pack without gaps.
  const columns: GifItemDTO[][] = [[], []];
  const heights = [0, 0];
  for (const gif of items) {
    const col = heights[0] <= heights[1] ? 0 : 1;
    columns[col].push(gif);
    heights[col] += gif.height / gif.width;
  }

  const errorText =
    feed.error instanceof ApiError ? feed.error.message : feed.error ? "GIF search isn't available right now." : null;

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setText("");
          setQuery("");
        }
      }}
    >
      <Tooltip content="GIF">
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label="GIF"
            className="lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal disabled:opacity-40"
          >
            <ImagePlay size={ICON.md} />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 flex w-[min(92vw,22rem)] flex-col rounded-pane border border-hairline bg-base-700 p-2 shadow-lg"
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search KLIPY"
            aria-label="Search KLIPY for a GIF"
            maxLength={80}
            className="lx-focus mb-2 w-full rounded-row bg-base-600 px-2 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
          />
          <div ref={scrollRef} className="h-80 max-h-[50vh] overflow-y-auto overscroll-contain">
            {errorText ? (
              <p className="p-4 text-center text-xs text-signal-faint">{errorText}</p>
            ) : feed.isPending ? (
              <p className="p-4 text-center text-xs text-signal-faint">Loading GIFs…</p>
            ) : items.length === 0 ? (
              <p className="p-4 text-center text-xs text-signal-faint">No GIFs match that. Try another word.</p>
            ) : (
              <div className="flex gap-1">
                {columns.map((col, i) => (
                  <div key={i} className="flex min-w-0 flex-1 flex-col gap-1">
                    {col.map((gif) => (
                      <button
                        key={gif.slug}
                        type="button"
                        title={gif.title || "GIF"}
                        aria-label={gif.title ? `Send GIF: ${gif.title}` : "Send GIF"}
                        data-gif-slug={gif.slug}
                        onClick={() => {
                          onPick(gif, query);
                          setOpen(false);
                        }}
                        className="lx-focus relative block w-full overflow-hidden rounded-row bg-base-600 hover:ring-2 hover:ring-accent"
                        style={{
                          aspectRatio: `${gif.width} / ${gif.height}`,
                          backgroundImage: gif.blurPreview ? `url("${gif.blurPreview}")` : undefined,
                          backgroundSize: "cover",
                        }}
                      >
                        <img
                          src={attachmentUrl(gif.previewUrl)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div ref={sentinelRef} className="h-4" />
            {feed.isFetchingNextPage && <p className="pb-2 text-center text-xs text-signal-faint">Loading more…</p>}
          </div>
          <p className="pt-1.5 text-right text-micro text-signal-faint">Powered by KLIPY</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
