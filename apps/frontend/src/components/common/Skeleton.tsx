import { cn } from "../../lib/cn";

/**
 * Content-shaped loading placeholders.
 *
 * Used instead of a centred spinner wherever the shape of what's coming is known. A spinner says
 * "wait"; a skeleton says "a list of rows is arriving", and because it occupies the same space the
 * real content will, nothing jumps when the data lands.
 */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("lm-skeleton", className)} aria-hidden />;
}

/** A row with an avatar and two lines — the shape most lists in this app take. */
export function SkeletonRow({ lines = 2 }: { lines?: number }) {
  return (
    <div className="flex items-center gap-3 p-3">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3 w-1/3" />
        {lines > 1 && <Skeleton className="h-2.5 w-1/2" />}
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

/** Card shape for the ticket queue and similar grids. */
export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-xl border border-hairline bg-base-800 p-3">
      <Skeleton className="aspect-video w-full rounded-lg" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-2.5 w-2/3" />
    </div>
  );
}
