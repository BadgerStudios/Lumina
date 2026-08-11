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
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md bg-base-800 shadow-xl ${width}`}
        >
          <div className="flex items-center justify-between border-b border-base-900/60 px-5 py-4">
            <Dialog.Title className="text-lg font-semibold text-signal">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-signal-dim hover:text-signal">
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
