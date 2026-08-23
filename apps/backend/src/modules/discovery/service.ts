import { prisma } from "../../db/prisma.js";
import { serializeUser } from "../../lib/serialize.js";
import {
  serializeVideo,
  VIDEO_AUTHOR_SELECT,
  VIDEO_TAGS_INCLUDE,
  VIDEO_SOURCE_INCLUDE,
} from "../videos/serialize.js";
import { currentWindow, rotate, rotatesAt } from "./rotation.js";

/**
 * The Discover surface: new & popular videos, servers and people, for adults.
 *
 * ## Scope decisions, stated once
 *
 * - **Adult-only, at the route (requireAdult).** Discovery is a stranger-surfacing machine, which
 *   is precisely the thing minor accounts are insulated from. Gating the whole route is simpler
 *   and stronger than filtering minors out of each panel — though the people query excludes them
 *   anyway, because a defence that exists in one place is a defence that can be refactored away.
 *
 * - **Servers appear only if they opted in** (Server.discoverable). Every server on this instance
 *   predates discovery; listing them retroactively would publish the name and existence of every
 *   private community. The toggle lives in server settings → Community.
 *
 * - **"Popular" pools are wide and rotated, not ranked-and-frozen.** See rotation.ts for why.
 *   "New" panels don't need rotation — recency rotates them by itself.
 */

const WINDOW_DAYS = 30;
const RECENT_JOIN_DAYS = 7;
const POOL_SIZE = 50;
const PANEL_SIZE = 8;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function getDiscovery(viewerId: string) {
  const window = currentWindow();

  const [newVideos, popularVideoPool, discoverableServers, recentJoins, peoplePool, viewerLikes] =
    await Promise.all([
      prisma.video.findMany({
        where: { status: "APPROVED", createdAt: { gte: daysAgo(WINDOW_DAYS) } },
        include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
        orderBy: { createdAt: "desc" },
        take: PANEL_SIZE,
      }),
      prisma.video.findMany({
        where: { status: "APPROVED" },
        include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
        // likeCount weighted over raw views: a view is an autoplay, a like is a decision.
        orderBy: [{ likeCount: "desc" }, { viewCount: "desc" }],
        take: POOL_SIZE,
      }),
      prisma.server.findMany({
        where: { discoverable: true },
        select: {
          id: true,
          name: true,
          iconUrl: true,
          description: true,
          createdAt: true,
          isOfficial: true,
          _count: { select: { memberships: true } },
        },
      }),
      prisma.membership.groupBy({
        by: ["serverId"],
        where: { joinedAt: { gte: daysAgo(RECENT_JOIN_DAYS) } },
        _count: { serverId: true },
      }),
      prisma.user.findMany({
        // Adults only, never bots. Minors are already unreachable behind requireAdult, but this
        // query must not DEPEND on that staying true.
        where: {
          isMinor: false, isBot: false, ageRecordedAt: { not: null }, id: { not: viewerId },
          // Same reason as the lookup filter: an account can be fully usable and still not be
          // something Discover offers strangers.
          hiddenFromDirectory: false,
        },
        orderBy: { updatedAt: "desc" },
        take: POOL_SIZE,
      }),
      prisma.videoLike.findMany({ where: { userId: viewerId }, select: { videoId: true } }),
    ]);

  const likedIds = new Set(viewerLikes.map((l) => l.videoId));
  const joinsByServer = new Map(recentJoins.map((r) => [r.serverId, r._count.serverId]));

  // Growth beats size: a 40-member server that gained 12 this week is a livelier recommendation
  // than a 400-member one that gained nobody. log() keeps raw size as a tiebreak without letting
  // it dominate.
  const scoredServers = discoverableServers
    .map((s) => ({
      server: s,
      score: (joinsByServer.get(s.id) ?? 0) * 10 + Math.log1p(s._count.memberships),
    }))
    .sort((a, b) => b.score - a.score);

  const newServers = [...discoverableServers]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, PANEL_SIZE);

  const serializeServerCard = (s: (typeof discoverableServers)[number]) => ({
    id: s.id,
    name: s.name,
    iconUrl: s.iconUrl,
    description: s.description,
    memberCount: s._count.memberships,
    createdAt: s.createdAt.toISOString(),
    // Discover is exactly where an imitation would want to be seen, so the badge has to survive
    // the trip into this narrower card DTO rather than only existing on the full ServerDTO.
    isOfficial: s.isOfficial,
  });

  return {
    newVideos: newVideos.map((v) => serializeVideo(v, likedIds.has(v.id))),
    popularVideos: rotate(popularVideoPool, PANEL_SIZE, window, "videos").map((v) =>
      serializeVideo(v, likedIds.has(v.id)),
    ),
    newServers: newServers.map(serializeServerCard),
    popularServers: rotate(scoredServers, PANEL_SIZE, window, "servers").map((e) => serializeServerCard(e.server)),
    people: rotate(peoplePool, PANEL_SIZE, window, "people").map((u) => serializeUser(u)),
    rotatesAt: rotatesAt().toISOString(),
  };
}
