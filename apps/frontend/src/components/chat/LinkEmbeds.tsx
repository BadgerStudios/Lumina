import type { LinkPreviewDTO } from "@lumina/shared";

/**
 * Unfurled links.
 *
 * The image is loaded straight from the remote host, which is a deliberate and limited exception to
 * the rule in lib/markdown.ts that message text must never be able to emit an `<img>`. The
 * difference is where the URL came from: this one was extracted from a page *we* fetched and
 * validated (lib/safeFetch.ts), and only ever an https one. It still leaks the reader's IP to that
 * host on render — unavoidable for any link preview that shows a picture, and the reason
 * `referrerPolicy="no-referrer"` is set, so at least which channel they are reading does not travel
 * with it.
 */
export function LinkEmbeds({ embeds }: { embeds: LinkPreviewDTO[] }) {
  if (embeds.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {embeds.map((embed) => (
        <a
          key={embed.url}
          href={embed.url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex max-w-md gap-3 rounded-lg border-l-2 border-accent bg-base-700/60 p-2.5 no-underline transition hover:bg-base-700"
        >
          <div className="min-w-0 flex-1">
            {embed.siteName ? (
              <p className="truncate text-[11px] uppercase tracking-wide text-signal-faint">{embed.siteName}</p>
            ) : null}
            {embed.title ? <p className="break-words text-sm font-semibold text-accent">{embed.title}</p> : null}
            {embed.description ? (
              // Clamped rather than truncated at a character count: a two-line box keeps every
              // card the same height regardless of how verbose a site's meta description is.
              <p className="mt-0.5 line-clamp-2 break-words text-xs text-signal-dim">{embed.description}</p>
            ) : null}
          </div>
          {embed.imageUrl ? (
            <img
              src={embed.imageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-16 w-16 shrink-0 rounded object-cover"
              // A broken remote image should leave a clean card, not an alt-text box with a torn
              // page icon in it.
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : null}
        </a>
      ))}
    </div>
  );
}
