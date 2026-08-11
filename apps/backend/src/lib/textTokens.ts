/**
 * Hashtag and @mention extraction for feed text (video captions, video comments).
 *
 * Deliberately shared between the two so a caption and a comment can never disagree about what
 * counts as a tag — the alternative is two regexes that drift, and a hashtag that highlights in one
 * place and not the other reads as a bug even though both "work".
 *
 * Chat messages keep their own parser (modules/messages/mentions.ts): those resolve roles and
 * @everyone against a server's membership and permissions, which has no meaning on a cross-server
 * video feed. This one only ever resolves plain usernames.
 */

/**
 * A tag token. The trailing character class excludes a bare "#" and requires at least one letter
 * or digit somewhere, so "#" and "#___" don't become tags. Unicode letters are allowed so
 * non-Latin scripts aren't silently second-class, but the tag is still normalised by
 * modules/tags/service.ts before it reaches the database — this only decides what to hand it.
 */
const HASHTAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_]{1,40})/gu;

/** Usernames are the restricted set the register route enforces, so this cannot match something
 * that could never be an account. */
const MENTION_RE = /(?:^|[\s(])@([a-zA-Z0-9_]{2,32})/g;

function extract(re: RegExp, text: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const token = m[1];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

/** Bounded: a caption stuffed with a hundred hashtags is spam, and every one of them would
 * otherwise become a real Tag row that shows up in the typeahead for everyone. */
export function extractHashtags(text: string | null | undefined, limit = 10): string[] {
  if (!text) return [];
  return extract(HASHTAG_RE, text, limit);
}

/** Bounded for the same reason plus a concrete one: each resolved mention is a push notification,
 * so an unbounded list is a way to notify the whole instance from one comment. */
export function extractMentionUsernames(text: string | null | undefined, limit = 10): string[] {
  if (!text) return [];
  return extract(MENTION_RE, text, limit);
}
