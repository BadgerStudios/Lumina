import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

// Replaces native window.confirm/prompt (unstyled, OS-look, blocks the tab) with a themed Radix
// dialog, exposed imperatively so call sites stay one-liners:
//   const { confirm } = useConfirm();
//   if (!(await confirm({ title, description, danger: true }))) return;
//   const name = await prompt({ title: "Folder name", defaultValue: "New" }); if (name == null) return;

type ConfirmOpts = {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};
type PromptOpts = ConfirmOpts & { placeholder?: string; defaultValue?: string; required?: boolean };

type Req =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

const Ctx = createContext<{
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
} | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Req | null>(null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ kind: "confirm", opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setText(opts.defaultValue ?? "");
        setReq({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (value: boolean | string | null) => {
      if (!req) return;
      if (req.kind === "confirm") req.resolve(value as boolean);
      else req.resolve(value as string | null);
      setReq(null);
    },
    [req],
  );

  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const opts = req?.opts;
  const danger = opts?.danger;
  const isPrompt = req?.kind === "prompt";
  const promptOpts = isPrompt ? (req.opts as PromptOpts) : null;
  const canSubmit = !isPrompt || !promptOpts?.required || text.trim().length > 0;

  return (
    <Ctx.Provider value={api}>
      {children}
      <Dialog.Root
        open={req != null}
        onOpenChange={(o) => {
          // any dismissal (esc/scrim/close) = cancel
          if (!o) settle(isPrompt ? null : false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="lx-scrim lm-scrim fixed inset-0 z-[75]" />
          <Dialog.Content
            className="lx-raised lm-modal fixed left-1/2 top-1/2 z-[76] flex w-[min(90vw,26rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden"
            onOpenAutoFocus={(e) => {
              if (isPrompt) {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
              }
            }}
          >
            <div className="flex items-start gap-3 px-5 pt-5">
              {danger && (
                <span className="mt-0.5 shrink-0 text-flare">
                  <AlertTriangle size={20} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <Dialog.Title className="font-display text-base font-bold tracking-tight text-signal">
                  {opts?.title}
                </Dialog.Title>
                {opts?.description && (
                  <Dialog.Description className="mt-1 text-sm leading-relaxed text-signal-dim">
                    {opts.description}
                  </Dialog.Description>
                )}
              </div>
            </div>

            {isPrompt && (
              <form
                className="px-5 pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) settle(text.trim());
                }}
              >
                <input
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={promptOpts?.placeholder}
                  className="lx-focus w-full rounded-lg border border-hairline bg-base-800 px-3 py-2 text-sm text-signal outline-none placeholder:text-signal-faint"
                />
              </form>
            )}

            <div className="mt-5 flex justify-end gap-2 border-t border-hairline bg-base-800/40 px-5 py-3">
              <button
                type="button"
                onClick={() => settle(isPrompt ? null : false)}
                className="lx-focus rounded-lg px-3 py-1.5 text-sm font-semibold text-signal-dim transition hover:bg-base-600 hover:text-signal"
              >
                {opts?.cancelText ?? "Cancel"}
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => settle(isPrompt ? text.trim() : true)}
                className={cn(
                  "lx-focus rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50",
                  danger ? "bg-flare hover:bg-flare/90" : "bg-accent hover:bg-accent/90",
                )}
              >
                {opts?.confirmText ?? (danger ? "Delete" : "Confirm")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Ctx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}
