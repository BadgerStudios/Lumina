import { marked } from "marked";
import DOMPurify from "dompurify";

// Restricted feature set only: bold/italic/strike/code/inline-code/links/blockquote/line
// breaks. No raw HTML passthrough, no images, no headings/tables — this is a chat
// composer, not a document editor, and unrestricted HTML from other users is an XSS vector.
marked.use({
  breaks: true,
  gfm: true,
});

const ALLOWED_TAGS = ["b", "strong", "i", "em", "del", "s", "code", "pre", "a", "blockquote", "br", "p", "span"];
// `tabindex`/`role`/`aria-*` are here for spoilers (see markSpoilers) — a reveal control that only
// answers to a mouse is not a control. Someone typing these attributes by hand into chat can at
// worst make a normal word focusable, which is why widening the list this far is safe.
const ALLOWED_ATTR = ["href", "target", "rel", "class", "tabindex", "role", "aria-label", "aria-expanded"];

// The backend independently parses/persists real mentions (modules/messages/mentions.ts) for
// notification/@everyone-permission purposes, but doesn't annotate MessageDTO.content with
// which @tokens actually resolved. This regex re-derives the same tokens purely for rendering:
// it highlights any @word-shaped text, even one that wouldn't actually resolve to a real
// user/role server-side — a harmless cosmetic false positive, not a security or data issue.
const MENTION_RE = /(^|\s)(@everyone|@[a-zA-Z0-9_]+)/g;

function highlightMentions(text: string): string {
  return text.replace(MENTION_RE, (_match, pre: string, mention: string) => {
    const cls = mention === "@everyone" ? "mention mention-everyone" : "mention";
    return `${pre}<span class="${cls}">${mention}</span>`;
  });
}

/**
 * `||spoiler||`, Discord's own syntax.
 *
 * ## Why this runs BEFORE marked rather than after sanitizing
 *
 * The opposite of substituteEmoji below, and for the opposite reason. Emoji substitution has to
 * happen last because it emits an `<img>`, a tag the untrusted path must never be able to produce.
 * A spoiler emits a `<span class="spoiler">`, which is a tag and attribute the untrusted path is
 * *already* allowed to produce — so there is nothing to protect here, and running first means the
 * text inside a spoiler still gets its bold, links and emoji like any other text. Hiding a
 * formatted sentence is the normal case; hiding a raw one is the exception.
 *
 * Non-greedy and bounded: `||a|| and ||b||` is two spoilers, not one spanning the middle. It does
 * cross newlines, because a hidden block of several lines (a plot summary, a puzzle answer) is
 * exactly what people reach for this for.
 *
 * The known cost is the same one substituteEmoji documents: `||` inside a code block is treated as
 * a spoiler too. Worth it to keep the untrusted-input path narrow.
 */
const SPOILER_RE = /\|\|([\s\S]{1,4000}?)\|\|/g;

function markSpoilers(text: string): string {
  return text.replace(
    SPOILER_RE,
    (_match, inner: string) =>
      `<span class="spoiler" role="button" tabindex="0" aria-expanded="false" aria-label="Hidden text, activate to reveal">${inner}</span>`,
  );
}

/** `:name:` — same character class the server enforces on upload. */
const CUSTOM_EMOJI_RE = /:([a-z0-9_]{2,32}):/g;

/**
 * Substitutes `:name:` with the server's custom emoji.
 *
 * ## Why this runs AFTER sanitization
 *
 * `img` is deliberately NOT in ALLOWED_TAGS. Adding it would let anyone type a raw
 * `<img src="http://tracker/x.png">` into chat: DOMPurify would strip the event handlers so it is
 * not XSS, but every reader's IP and user-agent would be handed to whoever owns that host, on
 * sight, with no click required. That is a real privacy leak in a chat app.
 *
 * Substituting afterwards means the only `<img>` that can ever appear is one this function built,
 * from a URL that came out of our own emoji API — never from message text. Emoji names are
 * validated `[a-z0-9_]` server-side, so nothing here needs escaping beyond the map lookup itself.
 *
 * The known cost: a `:name:` inside a code block is substituted too. Worth it for a pipeline where
 * the untrusted path cannot emit an image at all.
 */
function substituteEmoji(html: string, emojis: Map<string, string>): string {
  if (emojis.size === 0) return html;
  return html.replace(CUSTOM_EMOJI_RE, (match, name: string) => {
    const url = emojis.get(name);
    if (!url) return match;
    return `<img class="custom-emoji" src="${url}" alt=":${name}:" title=":${name}:" draggable="false">`;
  });
}

export function renderMarkdown(raw: string, emojis?: Map<string, string>): string {
  const withMentions = markSpoilers(highlightMentions(raw));
  const html = marked.parse(withMentions, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ["target", "rel"],
  });
  return emojis ? substituteEmoji(clean, emojis) : clean;
}

/** Extracts distinct @mentions from raw composer text, for local highlighting purposes only. */
export function extractMentionTokens(raw: string): string[] {
  const tokens = new Set<string>();
  for (const match of raw.matchAll(MENTION_RE)) {
    tokens.add(match[2]);
  }
  return Array.from(tokens);
}
