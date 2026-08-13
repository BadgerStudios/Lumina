import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { renderMarkdown } from "../../lib/markdown";

/**
 * Rendered message text, plus the click/keyboard half of `||spoiler||`.
 *
 * The markup half lives in lib/markdown.ts, which turns `||…||` into a `span.spoiler`. Revealing is
 * handled here by delegation rather than by giving every spoiler its own listener, because the text
 * is injected as HTML — there are no React elements to attach handlers to. One listener on the
 * container also means a message with forty spoilers costs exactly as much as one with a single
 * spoiler.
 *
 * Reveal is deliberately one-way. A spoiler that can be re-hidden invites the "did I actually see
 * that?" double-take, and re-hiding text the reader has already read protects nothing.
 */
export function MessageContent({
  content,
  emojiMap,
  className,
}: {
  content: string;
  emojiMap?: Map<string, string>;
  className?: string;
}) {
  function reveal(target: EventTarget | null): boolean {
    const el = (target as HTMLElement | null)?.closest?.(".spoiler");
    if (!el || el.classList.contains("revealed")) return false;
    el.classList.add("revealed");
    el.setAttribute("aria-expanded", "true");
    el.setAttribute("aria-label", "Revealed text");
    return true;
  }

  return (
    <div
      className={className}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        // preventDefault in the bubble phase still cancels the default action, which is the point:
        // a link hidden inside a spoiler must not navigate on the same click that uncovers it.
        if (reveal(e.target)) e.preventDefault();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (reveal(e.target)) e.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content, emojiMap) }}
    />
  );
}

/**
 * Discord's other spoiler convention: an attachment whose filename starts with `SPOILER_` uploads
 * blurred. Handled here rather than server-side on purpose — it is a filename convention, not a
 * stored property, so renaming the file is the whole mechanism and nothing needs a schema column.
 */
export function isSpoilerAttachment(fileName: string): boolean {
  return fileName.startsWith("SPOILER_");
}

export function stripSpoilerPrefix(fileName: string): string {
  return isSpoilerAttachment(fileName) ? fileName.slice("SPOILER_".length) : fileName;
}

export function SpoilerAttachment({ fileName, children }: { fileName: string; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!isSpoilerAttachment(fileName) || revealed) return <>{children}</>;

  return (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      className="group/spoiler relative block w-fit overflow-hidden rounded-lg"
      aria-label={`Show hidden attachment ${stripSpoilerPrefix(fileName)}`}
    >
      <div className="pointer-events-none blur-2xl saturate-50">{children}</div>
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full bg-base-900/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-signal">
          Spoiler
        </span>
      </span>
    </button>
  );
}
