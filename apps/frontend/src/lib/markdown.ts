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
const ALLOWED_ATTR = ["href", "target", "rel", "class"];

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

export function renderMarkdown(raw: string): string {
  const withMentions = highlightMentions(raw);
  const html = marked.parse(withMentions, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR: ["target", "rel"],
  });
}

/** Extracts distinct @mentions from raw composer text, for local highlighting purposes only. */
export function extractMentionTokens(raw: string): string[] {
  const tokens = new Set<string>();
  for (const match of raw.matchAll(MENTION_RE)) {
    tokens.add(match[2]);
  }
  return Array.from(tokens);
}
