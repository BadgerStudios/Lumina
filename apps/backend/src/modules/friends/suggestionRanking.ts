/**
 * Ordering rules for "People you may know", kept pure and DB-free so they can be reasoned about
 * (and tested) without a database.
 *
 * Same posture as modules/feed/ranking.ts: a transparent score you can explain in one sentence,
 * no learned weights. On an instance with a few dozen real friendships there is nothing to learn
 * from, and pretending otherwise would be an opaque way to sort by luck.
 *
 * The scoring itself happens in SQL (see suggestions.ts) because every signal is an aggregate over
 * a join. What happens HERE is everything that depends on state the query shouldn't carry: how
 * often we've already shown someone, keeping the list from being identical every day, and making
 * sure the top of the list isn't five variations of the same reason.
 */

/** Every suggestion is attributed to exactly one bucket, in this priority order. Co-activity has
 * no bucket of its own: it influences the score but must never be stated as a reason (it would
 * disclose where and when someone posts, at a finer granularity than any existing endpoint). */
export type SuggestionReasonCode =
  | "DIRECT_DM"
  | "MUTUAL_FRIENDS"
  | "SHARED_GROUP_DM"
  | "SHARED_SERVER"
  | "NEW_TO_LUMINA";

const BUCKET_ORDER: SuggestionReasonCode[] = [
  "DIRECT_DM",
  "MUTUAL_FRIENDS",
  "SHARED_GROUP_DM",
  "SHARED_SERVER",
  "NEW_TO_LUMINA",
];

export interface ScoredCandidate {
  id: string;
  score: number;
  reasonCode: SuggestionReasonCode;
  mutualCount: number;
  sharedServerId: string | null;
  sharedGroupId: string | null;
  shownCount: number;
}

/**
 * Below this, a suggestion is dropped even if it leaves the list short or empty.
 *
 * The most important constant in the feature. Three good suggestions beat ten bad ones: a panel of
 * plausible-looking strangers is how this kind of feature loses trust permanently, and an empty
 * panel with an honest empty state is a much better outcome than a full one nobody believes.
 *
 * Calibration: sharing one 200-person server scores 0.16 and just clears. A high-degree account
 * reached via another high-degree account — the "you both know the admin" case — scores about
 * 0.045 and is dropped, without needing a special case for it.
 */
export const MIN_SCORE = 0.15;

/** Impressions before a candidate is suppressed outright (enforced in SQL, stated here so the two
 * halves of the rule live next to each other). Twelve views with no action is an answer. */
export const MAX_IMPRESSIONS = 12;

/**
 * Deterministic per-(viewer, candidate, day) value in [0, 1).
 *
 * Deterministic matters for the same reason it does in feed/ranking.ts: the panel is polled and
 * re-rendered constantly, and Math.random() here would make it reshuffle under the user's cursor
 * mid-click. Keyed on the day index so the order is stable within a day and moves between days.
 */
function jitter(viewerId: string, candidateId: string, dayIndex: number): number {
  let h = dayIndex >>> 0;
  for (const s of [viewerId, candidateId]) {
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Applies impression decay and daily jitter, drops anything under the floor, then interleaves the
 * reason buckets.
 *
 * Round-robin over buckets rather than a "max N per reason" cap: it guarantees that whatever
 * diversity exists shows up in the first few slots, and there is no tuning parameter to get wrong.
 * A list that is all "member of the same server" reads as one signal repeated, not as five
 * suggestions.
 */
export function rankSuggestions(
  viewerId: string,
  candidates: ScoredCandidate[],
  limit: number,
  now = Date.now(),
): ScoredCandidate[] {
  const dayIndex = Math.floor(now / 86_400_000);

  const adjusted = candidates
    .map((c) => {
      // Halves after six impressions, so a candidate the user keeps ignoring slides under fresher
      // rivals long before the hard suppression at twelve.
      const decay = 1 - Math.min(0.5, 0.08 * c.shownCount);
      const wobble = 0.94 + 0.12 * jitter(viewerId, c.id, dayIndex);
      return { ...c, score: c.score * decay * wobble };
    })
    // The floor is applied AFTER decay: something that only just cleared it on first sight should
    // stop being shown once it has been ignored a few times.
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  const buckets = new Map<SuggestionReasonCode, ScoredCandidate[]>();
  for (const c of adjusted) {
    const list = buckets.get(c.reasonCode);
    if (list) list.push(c);
    else buckets.set(c.reasonCode, [c]);
  }

  const out: ScoredCandidate[] = [];
  let exhausted = false;
  while (out.length < limit && !exhausted) {
    exhausted = true;
    for (const code of BUCKET_ORDER) {
      if (out.length >= limit) break;
      const list = buckets.get(code);
      if (list && list.length > 0) {
        out.push(list.shift()!);
        exhausted = false;
      }
    }
  }
  return out;
}

/**
 * The display string for a suggestion.
 *
 * Every reason here passes one test: it asserts only a fact the caller could already obtain from
 * an existing, permission-checked endpoint. That is why mutual friends are COUNTED but never
 * NAMED — no endpoint on this platform exposes another user's friend list, so "friends with Alice"
 * would invent a disclosure channel the rest of the app deliberately doesn't have. Servers and
 * group DMs may be named only because the caller can already enumerate their members, and only
 * after that membership is re-verified at serialization time.
 */
export function buildReason(
  code: SuggestionReasonCode,
  opts: { mutualCount?: number; serverName?: string | null; groupName?: string | null },
): string {
  switch (code) {
    case "DIRECT_DM":
      return "You've messaged each other";
    case "MUTUAL_FRIENDS": {
      const n = opts.mutualCount ?? 0;
      return n === 1 ? "1 mutual friend" : `${n} mutual friends`;
    }
    case "SHARED_GROUP_DM":
      return opts.groupName ? `In "${opts.groupName}" with you` : "In a group chat with you";
    case "SHARED_SERVER":
      return opts.serverName ? `Member of ${opts.serverName}` : "In a server with you";
    case "NEW_TO_LUMINA":
      return "Recently joined";
  }
}
