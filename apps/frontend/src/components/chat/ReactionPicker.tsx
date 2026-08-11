import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { SmilePlus } from "lucide-react";
import { COMMON_EMOJIS } from "../../lib/commonEmoji";

export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal" title="Add reaction">
          <SmilePlus size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          className="z-50 grid grid-cols-5 gap-1 rounded-md bg-base-600 p-2 shadow-lg"
        >
          {COMMON_EMOJIS.map((emoji) => (
            <DropdownMenu.Item
              key={emoji}
              onSelect={() => onPick(emoji)}
              className="cursor-pointer rounded p-1.5 text-lg outline-none hover:bg-base-500"
            >
              {emoji}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
