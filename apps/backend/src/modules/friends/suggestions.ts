import { Prisma } from "@prisma/client";
import type { FriendSuggestionDTO, FriendSuggestionsResponse } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { serializeUser } from "../../lib/serialize.js";
import {
  buildReason,
  rankSuggestions,
  MAX_IMPRESSIONS,
  type ScoredCandidate,
  type SuggestionReasonCode,
} from "./suggestionRanking.js";

/**
 * "People you may know".
 *
 * ## The one idea behind every signal
 *
 * Every signal here is "you and this person both belong to the same thing", and the only thing that
 * separates a good signal from a useless one is how big that thing is. Sharing a 2-person server is
 * near-proof you know each other; sharing a 500-person server is proof of nothing. So each signal
 * is weighted by `1 / (1 + ln(size))`, including mutual friends — where the "thing" is a person's
 * friend list, which makes it exactly Adamic/Adar. One idea, one place to tune, and no signal can
 * quietly become a firehose.
 *
 * `1/(1 + ln(d))` rather than the textbook `1/log(d)` because d = 1 is the common case on a small
 * instance and the textbook form divides by zero there.
 *
 * ## Why the age filter is NOT canContact()
 *
 * `canContact` answers "may these two interact", which is a weaker question than "should this
 * person be recommended". It used to be actively wrong here: a null `ageRecordedAt` counted as
 * MINOR and two minors matched, so filtering with it recommended every unverified account to every
 * other unverified account as a minor-to-minor cohort — hundreds of them — while showing verified
 * adults nothing. `canContact` no longer does that (unknown is now false on either side), so the
 * two predicates finally agree, but this filter stays explicit rather than delegating: Lumina is
 * 18+ (MINIMUM_AGE = 18), so a recorded minor can only be an AGE_MISMATCH hold awaiting human
 * review, not a cohort to build a social graph for. Both caller and candidate must be verified
 * adults, full stop.
 *
 * That predicate doubles as the best liveness filter the schema offers: an account with no age on
 * record is already blocked behind a non-dismissible modal (AgeGateModal.tsx), so recommending one
 * means recommending someone who will never see the request.
 *
 * ## What ranks but is never said
 *
 * Same-channel co-activity contributes to the score and never appears in a reason: it would
 * disclose where and when someone posts, at a finer granularity than any existing endpoint
 * exposes. See suggestionRanking.buildReason for the full privacy rule.
 */

/** Cache the RANKING only, never the DTOs — presence/avatar/displayName all change independently
 * and would go visibly stale. Users are re-read from Postgres on every request. */
const CACHE_TTL_SEC = 600;
const CACHE_LIMIT = 50;
const cacheKey = (userId: string) => `pymk:v1:${userId}`;

/** A request that was declined stops being suggested for this long, then becomes eligible again.
 *
 * Deliberately NOT permanent. resolveFriendRequest writes DECLINED both when the addressee declines
 * AND when the requester cancels their own outgoing request, so permanent suppression would mean a
 * misclick erases someone from your suggestions forever with no way to undo it. Someone who truly
 * means "never" has Block, which is permanent and absolute. */
const DECLINE_COOLDOWN_DAYS = 180;
/** Co-activity only counts recent conversation — two people who posted in the same channel a year
 * ago have no present-tense connection. */
const ACTIVITY_WINDOW_DAYS = 60;

interface RawRow {
  id: string;
  mutual_count: number;
  shared_server_count: number;
  smallest_shared_server: string | null;
  shared_group_count: number;
  smallest_shared_group: string | null;
  direct_dm: boolean;
  shared_channel_count: number;
  score: number;
}

/** Exactly one bucket per candidate, by strength of evidence. */
function classify(row: RawRow): SuggestionReasonCode {
  if (row.direct_dm) return "DIRECT_DM";
  if (row.mutual_count > 0) return "MUTUAL_FRIENDS";
  if (row.shared_group_count > 0) return "SHARED_GROUP_DM";
  return "SHARED_SERVER";
}

async function scoredCandidates(userId: string): Promise<RawRow[]> {
  return prisma.$queryRaw<RawRow[]>`
    WITH
    /* Every FriendRequest row touching the caller, direction-normalised, read once. */
    related AS (
      SELECT CASE WHEN fr."requesterId" = ${userId} THEN fr."addresseeId" ELSE fr."requesterId" END AS other_id,
             fr.status,
             COALESCE(fr."respondedAt", fr."createdAt") AS at
      FROM "FriendRequest" fr
      WHERE fr."requesterId" = ${userId} OR fr."addresseeId" = ${userId}
    ),
    my_friends AS (SELECT other_id AS id FROM related WHERE status = 'ACCEPTED'),

    /* Self, every existing relationship, declines still inside the cooldown, and anything this
       user dismissed or has already been shown too many times. */
    excluded AS (
      SELECT ${userId}::text AS id
      UNION SELECT other_id FROM related
             WHERE status <> 'DECLINED'
                OR at > now() - make_interval(days => ${DECLINE_COOLDOWN_DAYS}::int)
      UNION SELECT s."subjectId" FROM "FriendSuggestionState" s
             WHERE s."userId" = ${userId}
               AND ( (s."dismissedAt" IS NOT NULL AND s."dismissedAt" > now() - interval '180 days')
                  OR (s."shownCount" >= ${MAX_IMPRESSIONS}::int AND s."lastShownAt" > now() - interval '60 days') )
    ),

    /* Mutual friends, Adamic/Adar weighted: a mutual who knows everyone is weak evidence. */
    friend_edges AS (
      SELECT f.id AS via,
             CASE WHEN fr."requesterId" = f.id THEN fr."addresseeId" ELSE fr."requesterId" END AS reached
      FROM my_friends f
      JOIN "FriendRequest" fr
        ON fr.status = 'ACCEPTED' AND (fr."requesterId" = f.id OR fr."addresseeId" = f.id)
    ),
    via_degree AS (SELECT via, COUNT(*)::float AS d FROM friend_edges GROUP BY via),
    mutual AS (
      SELECT fe.reached AS cand, COUNT(*)::int AS n, SUM(1.0 / (1.0 + ln(vd.d))) AS w
      FROM friend_edges fe
      JOIN via_degree vd ON vd.via = fe.via
      WHERE fe.reached <> ${userId}
      GROUP BY fe.reached
    ),

    /* Shared servers, weighted by how small the server is. Bots are excluded from the size so a
       bot-padded server isn't mis-measured as large. */
    my_servers AS (SELECT "serverId" FROM "Membership" WHERE "userId" = ${userId}),
    server_size AS (
      SELECT m."serverId", COUNT(*)::float AS n
      FROM "Membership" m
      JOIN "User" u ON u.id = m."userId" AND NOT u."isBot"
      WHERE m."serverId" IN (SELECT "serverId" FROM my_servers)
      GROUP BY m."serverId"
    ),
    shared_server AS (
      SELECT m."userId" AS cand,
             COUNT(*)::int AS n,
             SUM(1.0 / (1.0 + ln(GREATEST(ss.n - 1, 1)))) AS w,
             (ARRAY_AGG(m."serverId" ORDER BY ss.n ASC))[1] AS smallest_shared_server
      FROM "Membership" m
      JOIN server_size ss ON ss."serverId" = m."serverId"
      WHERE m."userId" <> ${userId}
      GROUP BY m."userId"
    ),

    /* DM overlap. A direct 1:1 with someone who isn't a friend is the strongest evidence
       available: you have literally exchanged messages and simply never pressed Add Friend. */
    my_convos AS (SELECT "conversationId" FROM "DMParticipant" WHERE "userId" = ${userId}),
    convo_size AS (
      SELECT p."conversationId", COUNT(*)::float AS n
      FROM "DMParticipant" p
      WHERE p."conversationId" IN (SELECT "conversationId" FROM my_convos)
      GROUP BY p."conversationId"
    ),
    dm_overlap AS (
      SELECT p."userId" AS cand,
             BOOL_OR(NOT c."isGroup") AS direct_dm,
             COUNT(*) FILTER (WHERE c."isGroup")::int AS n_groups,
             SUM(CASE WHEN c."isGroup" THEN 1.0 / (1.0 + ln(GREATEST(cs.n - 1, 1))) ELSE 0 END) AS w_group,
             (ARRAY_AGG(c.id ORDER BY cs.n ASC) FILTER (WHERE c."isGroup"))[1] AS smallest_shared_group
      FROM "DMParticipant" p
      JOIN "DMConversation" c ON c.id = p."conversationId"
      JOIN convo_size cs ON cs."conversationId" = p."conversationId"
      WHERE p."userId" <> ${userId}
      GROUP BY p."userId"
    ),

    /* Both actually talked in the same channel recently. Ranking only — never a stated reason. */
    my_channels AS (
      SELECT DISTINCT "channelId" FROM "Message"
      WHERE "authorId" = ${userId} AND "channelId" IS NOT NULL AND "deletedAt" IS NULL
        AND "createdAt" > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS}::int)
    ),
    co_activity AS (
      SELECT m."authorId" AS cand, COUNT(DISTINCT m."channelId")::int AS n
      FROM "Message" m
      WHERE m."channelId" IN (SELECT "channelId" FROM my_channels)
        AND m."authorId" IS NOT NULL AND m."authorId" <> ${userId}
        AND m."deletedAt" IS NULL
        AND m."createdAt" > now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS}::int)
      GROUP BY m."authorId"
    ),

    pool AS (
      SELECT cand FROM mutual
      UNION SELECT cand FROM shared_server
      UNION SELECT cand FROM dm_overlap
      UNION SELECT cand FROM co_activity
    ),
    /* Liveness and safety. Every clause here is load-bearing: without them the panel fills with
       accounts that are dormant, banned, or unreachable behind the age gate. */
    eligible AS (
      SELECT u.id, u."createdAt"
      FROM pool p
      JOIN "User" u ON u.id = p.cand
      WHERE u.id NOT IN (SELECT id FROM excluded)
        AND NOT u."isBot"
        AND u."allowFriendRequests"
        AND u."ageRecordedAt" IS NOT NULL
        AND NOT u."isMinor"
        AND NOT EXISTS (
          SELECT 1 FROM "PlatformBan" b
          WHERE b."userId" = u.id AND b.scope = 'ACCOUNT' AND b."liftedAt" IS NULL
            AND (b."expiresAt" IS NULL OR b."expiresAt" > now()))
        AND NOT EXISTS (
          SELECT 1 FROM "AccountFlag" f
          WHERE f."userId" = u.id AND f.active AND f.severity IN ('HARD_BLOCK','SOFT_BLOCK'))
    )
    SELECT
      e.id,
      COALESCE(m.n, 0) AS mutual_count,
      COALESCE(ss.n, 0) AS shared_server_count,
      ss.smallest_shared_server,
      COALESCE(dm.n_groups, 0) AS shared_group_count,
      dm.smallest_shared_group,
      COALESCE(dm.direct_dm, false) AS direct_dm,
      COALESCE(ca.n, 0) AS shared_channel_count,
          1.60 * (CASE WHEN COALESCE(dm.direct_dm, false) THEN 1 ELSE 0 END)
        /* Dividing by the candidate's own degree is what turns "we have friends in common" into
           "our friend circles overlap proportionally" — i.e. the "similar friends" signal. Without
           it, anyone with hundreds of friends shares mutuals with everybody and floats to the top
           of every panel on the instance. */
        + 2.20 * COALESCE(m.w, 0) / (1.0 + ln(1.0 + cd.d))
        + 1.30 * COALESCE(dm.w_group, 0)
        + 1.00 * COALESCE(ss.w, 0)
        + 0.60 * LEAST(COALESCE(ca.n, 0), 3) / 3.0
        + 0.25 * exp(-EXTRACT(EPOCH FROM (now() - e."createdAt")) / (14 * 86400.0))
        AS score
    FROM eligible e
    LEFT JOIN mutual m ON m.cand = e.id
    LEFT JOIN shared_server ss ON ss.cand = e.id
    LEFT JOIN dm_overlap dm ON dm.cand = e.id
    LEFT JOIN co_activity ca ON ca.cand = e.id
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::float AS d FROM "FriendRequest" fr
      WHERE fr.status = 'ACCEPTED' AND (fr."requesterId" = e.id OR fr."addresseeId" = e.id)
    ) cd
    ORDER BY score DESC, e.id
    LIMIT ${CACHE_LIMIT}::int;
  `;
}

/**
 * Cold-start fallback: recently-joined accounts that look alive.
 *
 * Kept as a separate query rather than folded into the scored one, because it is explicitly NOT an
 * inference — there is no connection between these people and the caller, and merging the two is
 * how "recently joined" quietly starts outranking real signals. Hard-capped, and the response
 * labels it so the UI can present it honestly rather than passing it off as a real suggestion.
 *
 * The profile/message clause is the difference between this being useful and being a directory of
 * dormant accounts. It is deliberately NOT applied to the scored path above, where a real shared
 * server or mutual friend is itself proof of life and shouldn't be vetoed by a missing avatar.
 */
const FALLBACK_LIMIT = 3;

async function fallbackCandidates(userId: string, excludeIds: string[]): Promise<Array<{ id: string }>> {
  const exclude = [userId, ...excludeIds];
  return prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u.id
    FROM "User" u
    WHERE u.id <> ALL(${exclude}::text[])
      AND NOT u."isBot"
      AND u."allowFriendRequests"
      AND u."ageRecordedAt" IS NOT NULL
      AND NOT u."isMinor"
      AND (u."avatarUrl" IS NOT NULL OR u.bio IS NOT NULL OR u."displayName" IS NOT NULL)
      AND EXISTS (SELECT 1 FROM "Message" mm WHERE mm."authorId" = u.id AND mm."deletedAt" IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "FriendRequest" fr
        WHERE (fr."requesterId" = u.id AND fr."addresseeId" = ${userId})
           OR (fr."addresseeId" = u.id AND fr."requesterId" = ${userId}))
      AND NOT EXISTS (
        SELECT 1 FROM "FriendSuggestionState" s
        WHERE s."userId" = ${userId} AND s."subjectId" = u.id AND s."dismissedAt" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "PlatformBan" b
        WHERE b."userId" = u.id AND b.scope = 'ACCOUNT' AND b."liftedAt" IS NULL
          AND (b."expiresAt" IS NULL OR b."expiresAt" > now()))
      AND NOT EXISTS (
        SELECT 1 FROM "AccountFlag" f
        WHERE f."userId" = u.id AND f.active AND f.severity IN ('HARD_BLOCK','SOFT_BLOCK'))
    ORDER BY u."createdAt" DESC
    LIMIT ${FALLBACK_LIMIT}::int;
  `;
}

async function readCache(userId: string): Promise<RawRow[] | null> {
  try {
    const raw = await redis.get(cacheKey(userId));
    return raw ? (JSON.parse(raw) as RawRow[]) : null;
  } catch {
    return null; // fail open — the query is the source of truth, the cache is only an optimisation
  }
}

async function writeCache(userId: string, rows: RawRow[]): Promise<void> {
  try {
    await redis.set(cacheKey(userId), JSON.stringify(rows), "EX", CACHE_TTL_SEC);
  } catch {
    /* caching is an optimisation, not a requirement */
  }
}

/** Called from every friend-graph mutation. Deliberately only invalidates the two people directly
 * involved — invalidating the whole 2-hop neighbourhood is where cache bugs live, and the 600s TTL
 * covers the second-order staleness perfectly well. */
export async function invalidateSuggestions(...userIds: string[]): Promise<void> {
  try {
    await redis.del(...userIds.map(cacheKey));
  } catch {
    /* the TTL will catch it */
  }
}

export async function getFriendSuggestions(userId: string, limit: number): Promise<FriendSuggestionsResponse> {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { ageRecordedAt: true, isMinor: true },
  });
  // Self-describing rather than load-bearing: an account in this state is already stopped by the
  // full-screen age gate, so no UI will ever render this branch.
  if (!me || me.ageRecordedAt === null || me.isMinor) return { suggestions: [], gated: "AGE_UNVERIFIED" };

  let rows = await readCache(userId);
  if (rows === null) {
    rows = await scoredCandidates(userId);
    await writeCache(userId, rows);
  }

  // Impression counts are read AFTER the cache and from Postgres, so a dismissal takes effect on
  // the very next request without having to invalidate anything.
  const states = await prisma.friendSuggestionState.findMany({
    where: { userId, subjectId: { in: rows.map((r) => r.id) } },
    select: { subjectId: true, shownCount: true, dismissedAt: true },
  });
  const stateBySubject = new Map(states.map((s) => [s.subjectId, s]));

  const candidates: ScoredCandidate[] = rows
    .filter((r) => !stateBySubject.get(r.id)?.dismissedAt)
    .map((r) => ({
      id: r.id,
      score: Number(r.score),
      reasonCode: classify(r),
      mutualCount: Number(r.mutual_count),
      sharedServerId: r.smallest_shared_server,
      sharedGroupId: r.smallest_shared_group,
      shownCount: stateBySubject.get(r.id)?.shownCount ?? 0,
    }));

  const ranked = rankSuggestions(userId, candidates, limit);

  // Only reach for filler when the real signals genuinely came up short.
  if (ranked.length < limit) {
    const fallback = await fallbackCandidates(userId, ranked.map((r) => r.id));
    for (const f of fallback) {
      if (ranked.length >= limit) break;
      ranked.push({
        id: f.id,
        score: 0,
        reasonCode: "NEW_TO_LUMINA",
        mutualCount: 0,
        sharedServerId: null,
        sharedGroupId: null,
        shownCount: 0,
      });
    }
  }

  if (ranked.length === 0) return { suggestions: [] };

  const ids = ranked.map((r) => r.id);
  // Re-verified at hydration: someone banned or opted-out thirty seconds ago must not be served
  // from a ten-minute-old ranking.
  const users = await prisma.user.findMany({
    where: {
      id: { in: ids },
      isBot: false,
      allowFriendRequests: true,
      ageRecordedAt: { not: null },
      isMinor: false,
    },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  // Reason subjects are only named after confirming the caller can already see them by other
  // means — a member of the server can already enumerate its members, so naming it discloses
  // nothing new; if that membership has since gone, the reason is downgraded rather than the
  // person being dropped.
  const serverIds = ranked.map((r) => r.sharedServerId).filter((v): v is string => v !== null);
  const groupIds = ranked.map((r) => r.sharedGroupId).filter((v): v is string => v !== null);
  const [servers, groups] = await Promise.all([
    serverIds.length
      ? prisma.server.findMany({
          where: { id: { in: serverIds }, memberships: { some: { userId } } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    groupIds.length
      ? prisma.dMConversation.findMany({
          where: { id: { in: groupIds }, participants: { some: { userId } } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const serverById = new Map(servers.map((s) => [s.id, s.name]));
  const groupById = new Map(groups.map((g) => [g.id, g.name]));

  const suggestions: FriendSuggestionDTO[] = [];
  for (const r of ranked) {
    const user = userById.get(r.id);
    if (!user) continue;

    let code = r.reasonCode;
    // Downgrade rather than drop: an unexplained face is the worst version of this UI, but so is
    // removing a real suggestion over a stale reason.
    if (code === "SHARED_SERVER" && !(r.sharedServerId && serverById.has(r.sharedServerId))) {
      code = r.mutualCount > 0 ? "MUTUAL_FRIENDS" : "NEW_TO_LUMINA";
    }
    if (code === "SHARED_GROUP_DM" && !(r.sharedGroupId && groupById.has(r.sharedGroupId))) {
      code = r.mutualCount > 0 ? "MUTUAL_FRIENDS" : "NEW_TO_LUMINA";
    }

    suggestions.push({
      user: serializeUser(user),
      reasonCode: code,
      reason: buildReason(code, {
        mutualCount: r.mutualCount,
        serverName: r.sharedServerId ? (serverById.get(r.sharedServerId) ?? null) : null,
        groupName: r.sharedGroupId ? (groupById.get(r.sharedGroupId) ?? null) : null,
      }),
      ...(code === "MUTUAL_FRIENDS" ? { mutualFriendCount: r.mutualCount } : {}),
    });
  }

  // One statement for the whole panel, not one per candidate.
  if (suggestions.length > 0) {
    const values = suggestions.map((s) => Prisma.sql`(${userId}, ${s.user.id}, 1, now())`);
    await prisma.$executeRaw`
      INSERT INTO "FriendSuggestionState" ("userId", "subjectId", "shownCount", "lastShownAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("userId", "subjectId")
      DO UPDATE SET "shownCount" = "FriendSuggestionState"."shownCount" + 1, "lastShownAt" = now();
    `;
  }

  return { suggestions };
}

export async function dismissSuggestion(userId: string, subjectId: string): Promise<void> {
  await prisma.friendSuggestionState.upsert({
    where: { userId_subjectId: { userId, subjectId } },
    create: { userId, subjectId, dismissedAt: new Date(), shownCount: 0 },
    update: { dismissedAt: new Date() },
  });
}
