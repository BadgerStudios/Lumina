import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* `lm-scrim` / `lm-modal` (styles/motion.css) drive both the enter AND the exit off Radix's
            data-state, which is what lets a dismissal animate at all — Radix keeps the element
            mounted until the animation ends.

            They replace `animate-in fade-in`, which are tailwindcss-animate utilities. That plugin
            is not a dependency of this project and those class names resolved to nothing, so every
            dialog in the app was appearing and vanishing with no animation whatsoever. */}
        {/* Above the mobile tab bar (z-50), not below it: at z-40 the scrim dimmed the whole app
            except the tab bar, which stayed bright AND tappable underneath an open dialog. */}
        <Dialog.Overlay className="lx-scrim lm-scrim fixed inset-0 z-[55]" />
        {/* Sized against the MEASURED viewport rather than `85vh`/`90vw`.
            `vh` is the URL-bar-retracted height on mobile, so an 85vh modal could still overflow
            the visible area, and with the dialog centred the overflow lands off BOTH ends — the
            title scrolls out of reach at the top and the confirm button at the bottom.
            Subtracting the keyboard inset matters most here: nearly every modal in the app has a
            text field in it. */}
        <Dialog.Content
          className={`lx-raised lm-modal fixed left-1/2 top-1/2 z-[56] flex overflow-hidden max-h-[calc(var(--app-height-safe)*0.90)] w-[min(90vw,calc(var(--app-width)-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col ${width}`}
        >
          {/* The header stays put and only the body scrolls — on a landscape phone the whole modal
              is barely taller than the header, and a scrolled-away title leaves no way to tell what
              is being confirmed. */}
          <div className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-4 short:py-2.5">
            <Dialog.Title className="font-display text-base font-bold tracking-tight text-signal short:text-sm">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="lx-focus rounded-lg p-1 text-signal-dim transition hover:bg-base-600 hover:text-signal" aria-label="Close">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
