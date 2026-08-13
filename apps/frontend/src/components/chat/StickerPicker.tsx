import { useState } from "react";
// DropdownMenu rather than Popover, because Popover is not a dependency of this app and the two
// are interchangeable for this. `onKeyDown` on the search box stops Radix's own typeahead from
// eating the keystrokes — a menu treats letters as "jump to the item starting with this", which
// makes a text input inside one unusable without it.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Sticker as StickerIcon } from "lucide-react";
import { useStickers } from "../../queries/expressions";
import { resolveAssetUrl } from "../../lib/apiClient";

/**
 * Sticker picker.
 *
 * Only rendered when there is a server to pick from — stickers are server-scoped, so in a DM there
 * is nothing to show and the button is absent rather than present and empty.
 */
export function StickerPicker({ serverId, onPick }: { serverId: string; onPick: (stickerId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { data: stickers, isLoading } = useStickers(open ? serverId : undefined);

  const visible = (stickers ?? []).filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="mb-0.5 shrink-0 text-signal-dim hover:text-signal"
          title="Send a sticker"
          aria-label="Send a sticker"
        >
          <StickerIcon size={20} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-lg border border-base-500 bg-base-700 p-2 shadow-lg"
        >
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search stickers"
            aria-label="Search stickers"
            className="mb-2 w-full rounded bg-base-600 px-2 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
          />
          {isLoading ? (
            <p className="p-4 text-center text-xs text-signal-faint">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="p-4 text-center text-xs text-signal-faint">
              {stickers?.length ? "Nothing matches that." : "This server has no stickers yet."}
            </p>
          ) : (
            <div className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto">
              {visible.map((sticker) => (
                <button
                  key={sticker.id}
                  type="button"
                  onClick={() => {
                    onPick(sticker.id);
                    setOpen(false);
                  }}
                  title={sticker.description ?? sticker.name}
                  className="flex flex-col items-center gap-0.5 rounded p-1.5 hover:bg-base-600"
                >
                  <img
                    src={resolveAssetUrl(sticker.imageUrl)}
                    alt={sticker.name}
                    className="h-16 w-16 object-contain"
                    draggable={false}
                  />
                  <span className="w-full truncate text-center text-[10px] text-signal-dim">{sticker.name}</span>
                </button>
              ))}
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
