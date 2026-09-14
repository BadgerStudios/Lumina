import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { Modal } from "./modals/Modal";
import { useDismissMotd, useMotd } from "../queries/motd";

/**
 * The owner's message of the day, shown once on the first load of the day.
 *
 * Deliberately a modal rather than a banner. This is the one channel that reaches everyone without
 * being asked for, which is worth something only if it is used rarely — a dismissible strip along
 * the top gets scrolled past and stops being read within a week, and then it is not a channel any
 * more. The server decides whether there is anything to show at all, so an ordinary day costs one
 * cheap request that answers null.
 *
 * The dismissal is recorded against the id that was actually displayed, not against "whatever is
 * active now" — see queries/motd.ts.
 */
export function MotdModal() {
  const { data } = useMotd();
  const dismiss = useDismissMotd();
  const motd = data?.motd ?? null;

  const [open, setOpen] = useState(false);
  // Opened from an effect rather than rendered directly off the query, so the dialog gets a real
  // closed-to-open transition instead of appearing already open the moment the fetch lands.
  useEffect(() => {
    if (motd) setOpen(true);
  }, [motd]);

  if (!motd) return null;

  const close = () => {
    setOpen(false);
    dismiss.mutate(motd.id);
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()} title={motd.title ?? "Message of the day"}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex gap-3">
          <span className="mt-0.5 shrink-0 text-accent">
            <Megaphone size={20} />
          </span>
          {/* whitespace-pre-wrap: the composer is a plain textarea, so the line breaks someone
              typed are the formatting they intended. */}
          <p className="min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-signal">{motd.body}</p>
        </div>
        <button
          type="button"
          onClick={close}
          className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover"
        >
          Got it
        </button>
      </div>
    </Modal>
  );
}
