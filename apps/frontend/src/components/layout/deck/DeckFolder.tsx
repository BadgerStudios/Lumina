import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Folder, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ServerFolderDTO } from "@lumina/shared";
import { cn } from "../../../lib/cn";
import { useUpdateFolder, useDeleteFolder } from "../../../queries/serverFolders";

/** A small, legible palette for folder accents. */
const FOLDER_COLORS = ["#5865f2", "#3ba55d", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];

const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-signal outline-none data-[highlighted]:bg-base-600";

/**
 * One sidebar folder: a collapsible header carrying its spaces (passed as children so the deck's own
 * space-row renderer stays the single source of truth for what a space looks like). The folder is a
 * per-user organising device only — see the ServerFolder model.
 */
export function DeckFolder({
  folder,
  count,
  open,
  onToggle,
  children,
}: {
  folder: ServerFolderDTO;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const updateFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();

  return (
    <div>
      <div className="group relative flex items-center">
        <button onClick={onToggle} aria-expanded={open} title={folder.name} className="lx-row lx-focus text-sm">
          <ChevronRight
            size={13}
            className={cn("shrink-0 text-signal-faint transition-transform", open && "rotate-90")}
          />
          <span
            className="grid size-[22px] shrink-0 place-items-center rounded-lg"
            style={{ background: folder.color ?? "var(--base-600, #3a3a3a)" }}
          >
            <Folder size={13} className="text-white/90" />
          </span>
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-signal-faint">{count}</span>
        </button>
        <span className="absolute right-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-signal-faint hover:text-signal"
                aria-label={`${folder.name} folder menu`}
              >
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={6} className="lx-raised z-50 w-52 p-1.5">
                <DropdownMenu.Item
                  className={menuItem}
                  onSelect={() => {
                    const name = window.prompt("Rename folder", folder.name);
                    if (name?.trim()) updateFolder.mutate({ id: folder.id, name: name.trim() });
                  }}
                >
                  <Pencil size={15} /> Rename
                </DropdownMenu.Item>
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  {FOLDER_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => updateFolder.mutate({ id: folder.id, color: c })}
                      className={cn(
                        "size-4 rounded-full ring-1 ring-inset ring-black/20 transition hover:scale-110",
                        folder.color === c && "ring-2 ring-signal",
                      )}
                      style={{ background: c }}
                      aria-label={`Set folder colour ${c}`}
                    />
                  ))}
                </div>
                <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                <DropdownMenu.Item
                  className={cn(menuItem, "text-flare")}
                  onSelect={() => {
                    if (confirm(`Delete folder "${folder.name}"? The spaces inside stay in your list.`)) {
                      deleteFolder.mutate(folder.id);
                    }
                  }}
                >
                  <Trash2 size={15} /> Delete folder
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </span>
      </div>
      {open && <div className="ml-2 border-l border-hairline pl-1">{children}</div>}
    </div>
  );
}
