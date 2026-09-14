import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
// DropdownMenu (not Popover) to match StickerPicker — Popover isn't a dependency of this app and the
// two are interchangeable here. `onKeyDown` stopPropagation on the search box stops Radix's own menu
// typeahead from eating the keystrokes.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Smile } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { ICON } from "../common/Icon";
import { useCustomEmojis } from "../../queries/emoji";
import { resolveAssetUrl } from "../../lib/apiClient";
import { cn } from "../../lib/cn";
import { EMOJI_SET, DEFAULT_EMOJIS } from "./emojiData";

/**
 * A searchable emoji picker shared by the composer (inserts `:name:` / the unicode char at the
 * caret) and the reaction picker. Includes the server's custom emoji when a `serverId` is given —
 * custom emoji are inserted as their `:name:` token, which the message renderer substitutes for the
 * image (see lib/markdown.ts).
 */
export function EmojiPicker({
  serverId,
  onPick,
  side = "top",
  align = "end",
  triggerClassName,
  triggerLabel = "Emoji",
  icon,
  closeOnPick = true,
}: {
  serverId?: string;
  /** Receives a unicode emoji character, or a `:name:` token for a custom emoji. */
  onPick: (value: string) => void;
  side?: DropdownMenu.DropdownMenuContentProps["side"];
  align?: DropdownMenu.DropdownMenuContentProps["align"];
  triggerClassName?: string;
  triggerLabel?: string;
  icon?: ReactNode;
  closeOnPick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: customEmojis } = useCustomEmojis(open ? serverId : undefined);

  // Focus the search box once the menu is open (DropdownMenu.Content has no onOpenAutoFocus; the
  // timeout lets Radix finish its own focus management first).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const term = filter.trim().toLowerCase();

  const unicode = useMemo(() => {
    if (!term) return DEFAULT_EMOJIS.map((char) => ({ char, keywords: "" }));
    return EMOJI_SET.filter((e) => e.keywords.includes(term));
  }, [term]);

  const custom = useMemo(
    () => (customEmojis ?? []).filter((e) => !term || e.name.toLowerCase().includes(term)),
    [customEmojis, term],
  );

  function pick(value: string) {
    onPick(value);
    if (closeOnPick) setOpen(false);
  }

  const nothingMatches = unicode.length === 0 && custom.length === 0;

  return (
    <DropdownMenu.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setFilter(""); }}>
      <Tooltip content={triggerLabel}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={triggerLabel}
            className={
              triggerClassName ??
              "lx-focus mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-signal-dim transition hover:bg-base-600 hover:text-signal"
            }
          >
            {icon ?? <Smile size={ICON.md} />}
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align={align}
          sideOffset={8}
          // Don't yank focus back to the trigger on close — the caller's onPick handler manages
          // focus (the composer restores the textarea caret to insert at the right spot).
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-72 rounded-pane border border-hairline bg-base-700 p-2 shadow-lg"
        >
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="lx-focus mb-2 w-full rounded-row bg-base-600 px-2 py-1.5 text-sm text-signal outline-none placeholder:text-signal-faint"
          />
          <div className="max-h-64 overflow-y-auto">
            {nothingMatches ? (
              <p className="p-4 text-center text-xs text-signal-faint">Nothing matches that.</p>
            ) : (
              <>
                {custom.length > 0 && (
                  <>
                    <p className="px-1 pb-1 pt-0.5 text-micro uppercase tracking-wide text-signal-faint">Custom</p>
                    <div className="mb-1 grid grid-cols-8 gap-0.5">
                      {custom.map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => pick(`:${e.name}:`)}
                          title={`:${e.name}:`}
                          className="flex aspect-square items-center justify-center rounded-row p-1 hover:bg-base-600"
                        >
                          <img
                            src={resolveAssetUrl(e.imageUrl)}
                            alt={`:${e.name}:`}
                            className="h-full w-full object-contain"
                            draggable={false}
                          />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {unicode.length > 0 && (
                  <>
                    {custom.length > 0 && (
                      <p className="px-1 pb-1 pt-0.5 text-micro uppercase tracking-wide text-signal-faint">Emoji</p>
                    )}
                    <div className="grid grid-cols-8 gap-0.5">
                      {unicode.map((e) => (
                        <button
                          key={e.char}
                          type="button"
                          onClick={() => pick(e.char)}
                          className={cn(
                            "flex aspect-square items-center justify-center rounded-row text-lg leading-none hover:bg-base-600",
                          )}
                        >
                          {e.char}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
