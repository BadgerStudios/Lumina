import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useToastStore } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/** Mounted once per app shell — AppShell for the chat app, OwnerApp for the owner console. Both are
 * needed: the two builds share components that call `toast`, and a build with no host mounted drops
 * every one of them silently, which is worst exactly where it matters most (the owner console's
 * "Android needs permission to install updates" prompt, where the visible symptom of a missing host
 * is a button that appears to do nothing).
 *
 * Anchored bottom-centre rather than top-right: on the ~390px viewport the Android WebView renders
 * at, a top-right toast lands under the header, and a bottom-right one sits on the
 * MobileBottomNav — so it clears the nav explicitly. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      // Clears the tab bar on mobile and the keyboard when it's open — a toast that lands behind
      // either is a message nobody reads.
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-nav-h)+0.75rem+var(--safe-bottom)+var(--keyboard-inset))] z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg",
            t.kind === "error" ? "border-dnd bg-base-800 text-signal" : "border-online bg-base-800 text-signal",
          )}
        >
          {t.kind === "error" ? (
            <AlertCircle size={17} className="mt-0.5 shrink-0 text-dnd" />
          ) : (
            <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-online" />
          )}
          <span className="min-w-0 flex-1 text-sm">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded p-0.5 text-signal-faint hover:bg-base-600 hover:text-signal"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
