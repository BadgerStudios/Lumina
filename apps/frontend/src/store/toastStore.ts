import { create } from "zustand";
import { ApiError } from "../lib/apiClient";

/**
 * Transient user-visible messages.
 *
 * The app had no way to tell anyone that an action failed. Every DM-creation call site did
 * `await createDM.mutateAsync(...)` inside a `void`-ed handler, so a rejected request became an
 * unhandled promise rejection: the button did nothing, twice, three times, with no explanation
 * anywhere on screen. That is indistinguishable from a dead button, and it is exactly how a
 * server-side 500 got reported as "sending DMs is broke" rather than as an error message anyone
 * could act on.
 *
 * Deliberately a store rather than per-component state — the thing that fails (a mutation in a
 * popover that closes on click) is frequently unmounted by the time the failure lands.
 */
export type ToastKind = "error" | "success";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Long enough to read a sentence, short enough not to sit over the composer. Errors linger:
 * the whole point is that they were previously invisible. */
const DURATION: Record<ToastKind, number> = { error: 6000, success: 3000 };

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++;
    // Identical back-to-back messages collapse: retrying a failing action three times should not
    // stack three copies of the same sentence.
    const existing = get().toasts;
    if (existing.some((t) => t.message === message && t.kind === kind)) return;
    set({ toasts: [...existing, { id, kind, message }] });
    setTimeout(() => get().dismiss(id), DURATION[kind]);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  error: (message: string) => useToastStore.getState().push("error", message),
  success: (message: string) => useToastStore.getState().push("success", message),
};

/**
 * Reports a caught error, preferring the server's own message.
 *
 * `fallback` is only used when the failure carries nothing readable (a network drop, a thrown
 * non-Error). An ApiError's message is the `error` field the backend deliberately chose to expose,
 * which is nearly always more specific and more honest than anything invented here.
 */
export function reportError(e: unknown, fallback: string): void {
  toast.error(e instanceof ApiError ? e.message : fallback);
}
