import { useState } from "react";
import { Loader2, Flag, Check, Trash2, X } from "lucide-react";
import {
  useReviewImages,
  useApproveImage,
  useRemoveImage,
  type ImageFilter,
  type ImageReviewRow,
} from "../queries/images";
import { UserAvatar } from "../components/common/UserAvatar";
import { Badge, EmptyState, Toolbar } from "./OwnerChrome";
import { cn } from "../lib/cn";
import { BanOptions, DEFAULT_REMOVAL_BAN, type RemovalBan } from "../components/common/BanOptions";

/**
 * Image review.
 *
 * Unlike every other list in the console this is a grid of cards rather than rows, for one reason:
 * the decision being made is about what the picture SHOWS, and a 28px thumbnail in a row cannot
 * support it. The image is the card, and everything else — who posted it, where, what was reported
 * about it — sits underneath at the size that information deserves.
 *
 * Reported images come first and are the default view, because an image somebody objected to is
 * worth more attention than the hundreds that arrived uneventfully.
 */

const FILTERS: Array<{ key: ImageFilter; label: string }> = [
  { key: "reported", label: "Reported" },
  { key: "pending", label: "Not yet reviewed" },
  { key: "all", label: "All" },
  { key: "removed", label: "Removed" },
];

export function OwnerImagesPanel() {
  const [filter, setFilter] = useState<ImageFilter>("reported");
  const [removing, setRemoving] = useState<ImageReviewRow | null>(null);
  const { data, isLoading } = useReviewImages(filter);
  const approve = useApproveImage();

  return (
    <div className="space-y-3">
      <Toolbar>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm transition-colors",
                filter === f.key
                  ? "bg-accent text-white"
                  : "bg-[var(--oc-panel-raised)] text-signal-dim hover:text-signal",
              )}
            >
              {f.label}
              {f.key === "reported" && data && data.counts.reported > 0 ? (
                <span className="ml-1.5 font-mono text-xs">{data.counts.reported}</span>
              ) : null}
              {f.key === "pending" && data && data.counts.pending > 0 ? (
                <span className="ml-1.5 font-mono text-xs">{data.counts.pending}</span>
              ) : null}
            </button>
          ))}
        </div>
      </Toolbar>

      {/* Said once, here, rather than left for someone to infer from an ever-growing backlog. */}
      <p className="text-xs text-signal-faint">
        Images are visible as soon as they're sent — this is the sweep afterwards, not a gate in
        front of it. Removing one takes it down everywhere and deletes the file.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-signal-faint" />
        </div>
      ) : !data || data.images.length === 0 ? (
        <EmptyState
          title={
            filter === "reported"
              ? "No reported images"
              : filter === "pending"
                ? "Everything has been reviewed"
                : filter === "removed"
                  ? "Nothing has been removed"
                  : "No images yet"
          }
          hint={filter === "reported" ? "Reports about a message with an image show up here." : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.images.map((image) => (
            <ImageCard
              key={image.id}
              image={image}
              busy={approve.isPending}
              onApprove={() => approve.mutate({ id: image.id })}
              onRemove={() => setRemoving(image)}
            />
          ))}
        </div>
      )}

      {removing && <RemoveDialog image={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function ImageCard({
  image,
  busy,
  onApprove,
  onRemove,
}: {
  image: ImageReviewRow;
  busy: boolean;
  onApprove: () => void;
  onRemove: () => void;
}) {
  const decided = image.reviewStatus !== "PENDING";
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-[var(--oc-panel)]",
        image.reports.length > 0 ? "border-[var(--oc-bad)]/40" : "border-[var(--oc-line)]",
      )}
    >
      <div className="relative aspect-video bg-black/40">
        {image.reviewStatus === "REMOVED" ? (
          // Nothing to show: the file is gone, which is the point.
          <div className="flex h-full flex-col items-center justify-center gap-1 text-signal-faint">
            <Trash2 className="h-5 w-5" aria-hidden="true" />
            <span className="text-xs">Removed</span>
          </div>
        ) : (
          <img
            src={image.url}
            alt={image.fileName}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        )}
        {image.reports.length > 0 && (
          <span className="absolute left-2 top-2">
            <Badge tone="bad">
              <Flag className="h-3 w-3" aria-hidden="true" />
              {image.reports.length} report{image.reports.length === 1 ? "" : "s"}
            </Badge>
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            avatarUrl={image.author?.avatarUrl ?? null}
            name={image.author?.displayName ?? image.author?.username ?? "Deleted account"}
            size={24}
          />
          <span className="min-w-0 flex-1 truncate text-sm text-signal">
            {image.author?.displayName ?? image.author?.username ?? "Deleted account"}
          </span>
          <span className="shrink-0 text-xs text-signal-faint">
            {new Date(image.createdAt).toLocaleDateString()}
          </span>
        </div>

        <p className="truncate text-xs text-signal-faint">{image.location}</p>

        {image.messageContent ? (
          <p className="line-clamp-2 rounded bg-[var(--oc-panel-raised)] px-2 py-1 text-xs text-signal-dim">
            {image.messageContent}
          </p>
        ) : null}

        {image.reports.map((r) => (
          <p key={r.id} className="text-xs text-[var(--oc-bad)]">
            {r.reason.replace(/_/g, " ").toLowerCase()}
            {r.details ? <span className="text-signal-faint"> — {r.details}</span> : null}
          </p>
        ))}

        {image.removalReason ? (
          <p className="text-xs text-signal-faint">Removed: {image.removalReason}</p>
        ) : null}

        <div className="mt-auto flex gap-2 pt-1">
          {image.reviewStatus === "REMOVED" ? (
            <Badge tone="bad">Removed</Badge>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onApprove}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[var(--oc-panel-raised)] px-2 py-1.5 text-xs text-signal hover:bg-[var(--oc-good)] hover:text-black disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                {decided ? "Cleared" : "Keep"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-[var(--oc-panel-raised)] px-2 py-1.5 text-xs text-signal hover:bg-[var(--oc-bad)] hover:text-white disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Remove
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Removing, and deciding whether that also means banning whoever posted it.
 *
 * The ban is off by default and has to be turned on deliberately: most removals are somebody's
 * first mistake, and a dialog that arrives with "ban this person" pre-selected makes the severe
 * outcome the accidental one. Once it IS on, the identifier choices are what decide whether the
 * ban survives a new signup — an account ban alone does not stop the same phone coming back.
 */
function RemoveDialog({ image, onClose }: { image: ImageReviewRow; onClose: () => void }) {
  const remove = useRemoveImage();
  const [reason, setReason] = useState("");
  const [banning, setBanning] = useState(false);
  const [ban, setBan] = useState<RemovalBan>(DEFAULT_REMOVAL_BAN);
  const name = image.author?.displayName ?? image.author?.username ?? "this account";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--oc-line)] bg-[var(--oc-panel)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-base text-signal">Remove this image</h2>
          <button type="button" onClick={onClose} aria-label="Cancel" className="text-signal-faint hover:text-signal">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <label className="block text-xs text-signal-dim">
          Why is it being removed?
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Shown on the ban if you issue one, and kept in the audit log."
            className="mt-1 w-full rounded-lg border border-[var(--oc-line)] bg-[var(--oc-panel-raised)] p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
          />
        </label>

        {image.author && (
          <div className="mt-3">
            <BanOptions
              name={name}
              banning={banning}
              onBanningChange={setBanning}
              ban={ban}
              onBanChange={setBan}
            />
          </div>
        )}

        {remove.isError && (
          <p className="mt-2 text-xs text-[var(--oc-bad)]">{(remove.error as Error).message}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg bg-[var(--oc-panel-raised)] px-3 py-2 text-sm text-signal"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!reason.trim() || remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: image.id, reason: reason.trim(), ban: banning ? ban : undefined },
                { onSuccess: onClose },
              )
            }
            className="flex-1 rounded-lg bg-[var(--oc-bad)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {remove.isPending ? "Removing…" : banning ? "Remove and ban" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
