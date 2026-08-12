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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in" />
        {/* Sized against the MEASURED viewport rather than `85vh`/`90vw`.
            `vh` is the URL-bar-retracted height on mobile, so an 85vh modal could still overflow
            the visible area, and with the dialog centred the overflow lands off BOTH ends — the
            title scrolls out of reach at the top and the confirm button at the bottom.
            Subtracting the keyboard inset matters most here: nearly every modal in the app has a
            text field in it. */}
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[calc(var(--app-height-safe)*0.90)] w-[min(90vw,calc(var(--app-width)-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-base-800 shadow-xl ${width}`}
        >
          {/* The header stays put and only the body scrolls — on a landscape phone the whole modal
              is barely taller than the header, and a scrolled-away title leaves no way to tell what
              is being confirmed. */}
          <div className="flex shrink-0 items-center justify-between border-b border-base-900/60 px-5 py-4 short:py-2.5">
            <Dialog.Title className="text-lg font-semibold text-signal short:text-base">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-signal-dim hover:text-signal" aria-label="Close">
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
