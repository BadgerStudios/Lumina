import type { FastifyInstance } from "fastify";
import { ageVisibilityFilter } from "../parental/visibility.js";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { serializeUser, serializeServer } from "../../lib/serialize.js";
import { searchTags } from "../tags/service.js";

/**
 * Typeahead lookup for people and servers. Mounted under /api/lookup.
 *
 * One endpoint pair behind every search box in the app, so results rank and render identically
 * everywhere instead of each surface hand-rolling its own query.
 */
const MAX_RESULTS = 8;
const HARD_MAX = 25;

/**
 * Below two characters a "contains" match returns a large share of the table and ranks by nothing
 * useful, so a single character returns suggestions instead of noise.
 */
const MIN_QUERY = 2;

interface Candidate {
  id: string;
  username: string;
  displayName: string | null;
  [key: string]: unknown;
}

/**
 * Ranks a candidate against the query.
 *
 * Ordering matters more than matching here: a "contains" query on a few hundred users returns
 * plenty of hits, and typing someone's exact username only to find them fourth is the specific
 * complaint that makes a search box feel broken. Exact beats prefix beats word-boundary beats
 * substring, then shorter names win (a query is a bigger fraction of a short name, so it is more
 * likely to be what was meant), then friends are lifted above strangers.
 */
function rank(user: Candidate, q: string, friendIds: Set<string>): number {
  const username = user.username.toLowerCase();
  const display = (user.displayName ?? "").toLowerCase();
  let score = 0;

  if (username === q || display === q) score = 1000;
  else if (username.startsWith(q) || display.startsWith(q)) score = 700;
  // A match at a word boundary ("smith" in "john smith") reads as intentional; one buried
  // mid-word ("mit" in "smith") usually doesn't.
  else if (new RegExp(`\\b${escapeRegex(q)}`).test(display)) score = 500;
  else score = 200;

  // Shorter is more specific: "sam" matching "sam" should beat "sam" matching "samantha_2019".
  const shortest = Math.min(username.length, display.length || Infinity);
  score += Math.max(0, 40 - shortest);

  if (friendIds.has(user.id)) score += 120;
  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default async function lookupRoutes(fastify: FastifyInstance) {
  /** Tag typeahead for the upload form and feed filter. */
  fastify.get(
    "/tags",
    { preHandler: [requireAuth], config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request) => {
      const query = request.query as { q?: string; limit?: string };
      const limit = Math.min(20, Math.max(1, Number(query.limit ?? 10) || 10));
      const tags = await searchTags(query.q ?? "", limit);
      // `suggested` when nothing was typed: the list is the most-used tags, not matches.
      return { tags, suggested: !(query.q ?? "").trim() };
    },
  );

  fastify.get(
    "/users",
    {
      preHandler: [requireAuth],
      // Fires per keystroke (debounced client-side). Generous, but capped — this is also the
      // endpoint someone would reach for to enumerate the user table.
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
    },
    async (request) => {
      const query = request.query as {
        q?: string;
        limit?: string;
        excludeSelf?: string;
        serverId?: string;
        friendsOnly?: string;
      };
      const q = (query.q ?? "").trim().toLowerCase();
      const limit = Math.min(HARD_MAX, Math.max(1, Number(query.limit ?? MAX_RESULTS) || MAX_RESULTS));
      const excludeSelf = query.excludeSelf !== "false";
      const userId = request.userId!;

      // The caller's accepted friends, used both to boost ranking and to power suggestions.
      const friendships = await prisma.friendRequest.findMany({
        where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true },
      });
      const friendIds = new Set(
        friendships.map((f) => (f.requesterId === userId ? f.addresseeId : f.requesterId)),
      );

      // Age visibility, applied to baseWhere so it reaches EVERY branch below — exact search,
      // the suggestion fallback, and the friends-only path alike. Putting it on each query
      // separately is how one of them ends up being the branch that still lists minors.
      const visibility = await ageVisibilityFilter(userId);

      // AND, not a spread. `visibility` is an { OR: [...] } object and the exact-search branch
      // below sets its OWN `OR` for the name match — spreading meant the second OR silently
      // replaced the first, and every minor became searchable by name. Nesting under AND makes
      // that collision impossible rather than merely fixed here.
      const baseWhere = {
        AND: [visibility],
        isBot: false,
        ...(excludeSelf ? { id: { not: userId } } : {}),
        ...(query.friendsOnly === "true" ? { id: { in: Array.from(friendIds) } } : {}),
        // Scoped to one server's members when asked — lets the same component back a member picker.
        ...(query.serverId ? { memberships: { some: { serverId: query.serverId } } } : {}),
      };

      // An empty or one-character query returns SUGGESTIONS rather than nothing. A picker that sits
      // blank until you have typed two characters makes you recall a name from memory; showing the
      // people you actually talk to means the common case is a single click.
      if (q.length < MIN_QUERY) {
        // A brand-new account has no friends, and returning nothing here meant the picker sat
        // empty on exactly the screen where someone has least idea who to look for. Fall back to
        // official accounts first (the people you'd actually want to reach on day one), then the
        // most recently active accounts, so every search populates the moment it opens.
        if (friendIds.size === 0) {
          const fallback = await prisma.user.findMany({
            where: { ...baseWhere, ...(excludeSelf ? { id: { not: userId } } : {}) },
            take: limit,
            orderBy: [{ isOfficial: "desc" }, { updatedAt: "desc" }],
          });
          return { users: fallback.map(serializeUser), suggested: true };
        }
        const suggestions = await prisma.user.findMany({
          where: { ...baseWhere, id: { in: Array.from(friendIds), ...(excludeSelf ? { not: userId } : {}) } },
          take: limit,
          orderBy: { username: "asc" },
        });
        const filtered = q
          ? suggestions.filter(
              (u) =>
                u.username.toLowerCase().includes(q) ||
                (u.displayName ?? "").toLowerCase().includes(q),
            )
          : suggestions;
        return {
          users: filtered.map((u) => ({ ...serializeUser(u), isFriend: true })),
          suggested: true,
        };
      }

      // Over-fetch, then rank in application code. Postgres can't express the ordering above, and
      // at this scale sorting a few dozen rows costs nothing compared to a second round trip.
      const candidates = await prisma.user.findMany({
        where: {
          ...baseWhere,
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
          ],
        },
        // Deliberately never matches on email: that would let anyone confirm whether a given
        // address has an account here.
        take: limit * 5,
      });

      const ranked = candidates
        .sort((a, b) => rank(b, q, friendIds) - rank(a, q, friendIds) || a.username.localeCompare(b.username))
        .slice(0, limit);

      return {
        users: ranked.map((u) => ({ ...serializeUser(u), isFriend: friendIds.has(u.id) })),
        suggested: false,
      };
    },
  );

  fastify.get(
    "/servers",
    { preHandler: [requireAuth], config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request) => {
      const query = request.query as { q?: string; limit?: string };
      const q = (query.q ?? "").trim().toLowerCase();
      const limit = Math.min(HARD_MAX, Math.max(1, Number(query.limit ?? MAX_RESULTS) || MAX_RESULTS));

      // Scoped to servers the caller belongs to. There is no public directory here, so an unscoped
      // search would leak the name and existence of every private community on the instance.
      const servers = await prisma.server.findMany({
        where: {
          memberships: { some: { userId: request.userId! } },
          ...(q.length >= MIN_QUERY ? { name: { contains: q, mode: "insensitive" } } : {}),
        },
        take: q.length >= MIN_QUERY ? limit * 3 : limit,
        orderBy: { name: "asc" },
      });

      const ranked =
        q.length >= MIN_QUERY
          ? servers
              .sort((a, b) => {
                const an = a.name.toLowerCase();
                const bn = b.name.toLowerCase();
                const s = (n: string) => (n === q ? 3 : n.startsWith(q) ? 2 : 1);
                return s(bn) - s(an) || an.localeCompare(bn);
              })
              .slice(0, limit)
          : servers;

      // Same "show something before you type" behaviour as users.
      return { servers: ranked.map(serializeServer), suggested: q.length < MIN_QUERY };
    },
  );
}
