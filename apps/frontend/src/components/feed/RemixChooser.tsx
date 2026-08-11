import * as Dialog from "@radix-ui/react-dialog";
import { Shuffle, Columns2, X } from "lucide-react";
import type { VideoDTO } from "@lumina/shared";

/**
 * The one-tap step between "remix this" and the recorder.
 *
 * Stitch and duet are different enough that offering them as one button would mean guessing, and
 * either one may be switched off by the source's author — so this only ever shows what is actually
 * permitted, and never renders at all when neither is.
 */
export function RemixChooser({
  video,
  onPick,
  onClose,
}: {
  video: VideoDTO | null;
  onPick: (mode: "STITCH" | "DUET") => void;
  onClose: () => void;
}) {
  if (!video || (!video.allowStitch && !video.allowDuet)) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-base-800 p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-signal">Remix this video</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-signal-dim hover:text-signal" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="flex flex-col gap-2">
            {video.allowDuet && (
              <Option
                icon={<Columns2 className="h-5 w-5" />}
                title="Duet"
                detail="Your video plays side by side with theirs."
                onClick={() => onPick("DUET")}
              />
            )}
            {video.allowStitch && (
              <Option
                icon={<Shuffle className="h-5 w-5" />}
                title="Stitch"
                detail="Quote up to 5 seconds of theirs, then say your piece."
                onClick={() => onPick("STITCH")}
              />
            )}
          </div>

          <p className="mt-3 text-xs text-signal-faint">
            @{video.author?.username ?? "the original creator"} is credited on anything you post.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Option({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded bg-base-900 p-3 text-left ring-1 ring-base-600 transition hover:ring-accent"
    >
      <span className="mt-0.5 text-accent">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-signal">{title}</span>
        <span className="block text-xs text-signal-dim">{detail}</span>
      </span>
    </button>
  );
}
