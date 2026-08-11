import { Fragment, useMemo } from "react";
import { cn } from "../../lib/cn";

/**
 * Renders feed text (video captions, comments) with clickable #hashtags and @mentions.
 *
 * Deliberately NOT the markdown pipeline chat messages use. That path parses raw text into HTML
 * and hands it to dangerouslySetInnerHTML after sanitising — appropriate for a composer that
 * supports bold/links/code, but far more machinery than a caption needs, and it makes a hashtag a
 * styled `<span>` rather than something you can click. Here the text is split into React nodes, so
 * a tag is a real button with a real handler and no HTML is ever constructed from user input at
 * all — there is nothing for a sanitiser to miss.
 *
 * The regexes mirror lib/textTokens.ts on the server, which decides which hashtags actually become
 * Tag rows. A token that highlights here but resolved to nothing server-side is a harmless
 * cosmetic false positive; the reverse would be worse, so the client pattern is the stricter of
 * the two only where it matters (a mention must look like a username).
 */
const TOKEN_RE = /(^|[\s(])([#@])([\p{L}\p{N}_]{1,40})/gu;

interface Segment {
  key: string;
  text: string;
  kind: "text" | "tag" | "mention";
  token?: string;
}

function segment(raw: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let i = 0;
  for (const m of raw.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const lead = m[1];
    const sigil = m[2];
    const token = m[3];
    // The leading whitespace/paren belongs to the plain text before the token, not to the token.
    if (start + lead.length > last) {
      out.push({ key: `t${i++}`, kind: "text", text: raw.slice(last, start + lead.length) });
    }
    out.push({
      key: `k${i++}`,
      kind: sigil === "#" ? "tag" : "mention",
      text: `${sigil}${token}`,
      token,
    });
    last = start + m[0].length;
  }
  if (last < raw.length) out.push({ key: `t${i++}`, kind: "text", text: raw.slice(last) });
  return out;
}

export function FeedText({
  text,
  onSelectTag,
  onSelectUser,
  className,
}: {
  text: string;
  onSelectTag?: (tag: string) => void;
  onSelectUser?: (username: string) => void;
  className?: string;
}) {
  const segments = useMemo(() => segment(text), [text]);

  return (
    <span className={className}>
      {segments.map((s) => {
        if (s.kind === "text") return <Fragment key={s.key}>{s.text}</Fragment>;

        const handler = s.kind === "tag" ? onSelectTag : onSelectUser;
        // With no handler the token still renders highlighted but inert — a caption shown somewhere
        // with nothing to navigate to should not offer a dead click.
        if (!handler) {
          return (
            <span key={s.key} className="font-medium opacity-90">
              {s.text}
            </span>
          );
        }
        return (
          <button
            key={s.key}
            type="button"
            onClick={(e) => {
              // Captions sit on top of the video, whose own click toggles playback.
              e.stopPropagation();
              handler(s.token!);
            }}
            className={cn(
              "font-medium underline-offset-2 hover:underline",
              s.kind === "tag" ? "text-accent" : "text-accent",
            )}
          >
            {s.text}
          </button>
        );
      })}
    </span>
  );
}
