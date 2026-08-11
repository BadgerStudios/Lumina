import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Star rating — interactive when `onRate` is given, read-only display otherwise.
 *
 * Hover previews the score by filling up to the star under the cursor, so the value is obvious
 * before committing. That matters here because a rating is one-shot: you cannot change it after
 * submitting, so it should never be possible to submit one by accident without seeing it first.
 */
export function StarRating({
  value,
  onRate,
  size = 20,
  label,
}: {
  value: number | null;
  onRate?: (rating: number) => void;
  size?: number;
  label?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  const interactive = Boolean(onRate);

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="flex items-center gap-0.5"
        role={interactive ? "radiogroup" : undefined}
        aria-label={label ?? (interactive ? "Rate this" : `Rated ${value ?? 0} of 5`)}
        onMouseLeave={() => setHover(null)}
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = n <= shown;
          return (
            <button
              key={n}
              type="button"
              disabled={!interactive}
              role={interactive ? "radio" : undefined}
              aria-checked={interactive ? value === n : undefined}
              aria-label={interactive ? `${n} star${n === 1 ? "" : "s"}` : undefined}
              onMouseEnter={() => interactive && setHover(n)}
              onClick={() => onRate?.(n)}
              className={cn(
                "lm-press",
                interactive ? "cursor-pointer" : "cursor-default",
                // Only the interactive version scales on hover; a read-only display that reacts to
                // the cursor implies it can be changed.
                interactive && "transition-transform hover:scale-110",
              )}
            >
              <Star
                style={{ width: size, height: size }}
                className={cn(
                  "transition-colors",
                  filled ? "text-amber" : "text-signal-faint",
                )}
                fill={filled ? "currentColor" : "none"}
              />
            </button>
          );
        })}
      </div>
      {label && <span className="text-xs text-signal-faint">{label}</span>}
    </div>
  );
}
