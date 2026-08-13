import { useState } from "react";
import type { ActionRowDTO } from "@lumina/shared";
import { useClickComponent } from "../../queries/interactions";
import { cn } from "../../lib/cn";

const STYLES: Record<string, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "bg-base-500 text-signal hover:bg-base-400",
  success: "bg-online/80 text-white hover:bg-online",
  danger: "bg-dnd/80 text-white hover:bg-dnd",
};

/**
 * Buttons and selects a bot attached to a message.
 *
 * Every control is disabled while its own interaction is in flight — not the whole row. A row
 * frequently holds "Approve" and "Reject" side by side, and freezing both because one is pending
 * would be right; freezing an unrelated row's controls would not.
 *
 * The bot's answer arrives as a normal message (or an ephemeral one), so there is nothing to render
 * here on success. The only thing this has to surface itself is the failure case, because a bot
 * that never answers otherwise looks exactly like a button that did nothing.
 */
export function MessageComponents({ messageId, rows }: { messageId: string; rows: ActionRowDTO[] }) {
  const click = useClickComponent();
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function activate(customId: string, values?: string[]) {
    setPending(customId);
    setFailure(null);
    try {
      const result = await click.mutateAsync({ messageId, customId, values });
      if (result.timedOut) setFailure(result.timedOut);
    } catch {
      // The mutation's own onError already raised a toast; this keeps the reason next to the
      // control that produced it, which is where someone is looking.
      setFailure("That didn't go through");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex flex-wrap items-center gap-1.5">
          {row.components.map((component) =>
            component.type === "button" ? (
              <button
                key={component.customId}
                type="button"
                disabled={component.disabled || pending === component.customId}
                onClick={() => void activate(component.customId)}
                className={cn(
                  "rounded px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50",
                  STYLES[component.style] ?? STYLES.secondary,
                )}
              >
                {pending === component.customId ? "…" : component.label}
              </button>
            ) : (
              <select
                key={component.customId}
                disabled={component.disabled || pending === component.customId}
                aria-label={component.placeholder ?? "Choose an option"}
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  void activate(component.customId, [e.target.value]);
                }}
                className="rounded border border-base-500 bg-base-600 px-2 py-1.5 text-xs text-signal outline-none disabled:opacity-50"
              >
                <option value="" disabled>
                  {component.placeholder ?? "Choose…"}
                </option>
                {component.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ),
          )}
        </div>
      ))}
      {failure ? <p className="text-[11px] text-dnd">{failure}</p> : null}
    </div>
  );
}
