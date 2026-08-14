import type { FastifyInstance } from "fastify";
import { z } from "zod";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { env } from "../../config/env.js";
import { requireAuth, requireOwner } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { applyRoleGrant } from "../../lib/roleGrant.js";
import { assignableRoles, isOwner } from "../../lib/platformRole.js";
import { serializeUser } from "../../lib/serialize.js";
import { banUser, liftBan, resolveAppeal } from "../bans/service.js";
import { getTranscodeQueue } from "../videos/queue.js";
import { getBandwidthSeries, getDownloadStats, getRevenueStats } from "../metrics/service.js";
import { isBillingConfigured } from "../billing/stripe.js";

const banSchema = z.object({
  reason: z.string().min(1).max(500),
  /** null = permanent. */
  durationDays: z.number().int().positive().max(3650).nullable().default(null),
  banEmail: z.boolean().default(true),
  banIp: z.boolean().default(false),
  banDevice: z.boolean().default(true),
});

const roleSchema = z.object({ platformRole: z.enum(["USER", "STAFF", "OWNER"]) });
const appealResolveSchema = z.object({
  approve: z.boolean(),
  response: z.string().min(1).max(500),
});

/**
 * Owner-only platform administration. Mounted under /api/owner.
 *
 * Separate from /api/staff because the authority differs in kind, not degree: staff moderate
 * content, the owner manages people and the platform itself. Every route carries requireOwner.
 */
export default async function ownerRoutes(fastify: FastifyInstance) {
  /** Headline platform statistics. Every number here is measured, never estimated. */
  fastify.get("/stats", { preHandler: [requireAuth, requireOwner] }, async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newUsersDay,
      newUsersWeek,
      totalServers,
      totalMessages,
      messagesDay,
      totalVideos,
      pendingVideos,
      openReports,
      pendingAppeals,
      activeBans,
      videoBytes,
      recentUsers,
      recentMessages,
      recentVideos,
      ageBlocks,
    ] = await Promise.all([
      prisma.user.count({ where: { isBot: false } }),
      prisma.user.count({ where: { isBot: false, createdAt: { gte: dayAgo } } }),
      prisma.user.count({ where: { isBot: false, createdAt: { gte: weekAgo } } }),
      prisma.server.count(),
      prisma.message.count(),
      prisma.message.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.video.count(),
      prisma.video.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.videoReport.count({ where: { status: "OPEN" } }),
      prisma.platformBan.count({ where: { appealStatus: "PENDING", liftedAt: null } }),
      prisma.platformBan.count({ where: { scope: "ACCOUNT", liftedAt: null } }),
      prisma.video.aggregate({ _sum: { sizeBytes: true } }),
      // 30-day series for the overview charts. Bucketed in application code rather than with raw
      // date_trunc SQL: the volume is small and this stays portable and readable.
      prisma.user.findMany({
        where: { isBot: false, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { createdAt: true },
      }),
      prisma.message.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { createdAt: true },
      }),
      prisma.video.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
        select: { createdAt: true },
      }),
      prisma.accountFlag.count({ where: { reasonCode: { startsWith: "AGE_" } } }),
    ]);

    const userSeries = bucketByDay(recentUsers.map((u) => u.createdAt), 30);
    const messageSeries = bucketByDay(recentMessages.map((m) => m.createdAt), 30);
    const videoSeries = bucketByDay(recentVideos.map((v) => v.createdAt), 30);

    return {
      users: { total: totalUsers, newToday: newUsersDay, newThisWeek: newUsersWeek, series: userSeries },
      servers: { total: totalServers },
      messages: { total: totalMessages, today: messagesDay, series: messageSeries },
      videos: {
        total: totalVideos,
        pendingReview: pendingVideos,
        storedBytes: videoBytes._sum.sizeBytes ?? 0,
        series: videoSeries,
      },
      moderation: { openReports, pendingAppeals, activeBans, ageBlocks },
    };
  });

  /**
   * "Needs attention" — the single list the owner should check first. Purely derived from real
   * counts; an empty response genuinely means there is nothing waiting.
   */
  /**
   * DAU/WAU + signup-cohort retention. "Active" is a REAL action: authored a message or
   * refreshed a session that day (token rotation mints a row per refresh, so RefreshToken
   * .createdAt is a faithful came-back signal; presence pings would overcount idle tabs).
   * Derived live from existing tables — no counters to drift, nothing new to maintain.
   */
  fastify.get("/engagement", { preHandler: [requireAuth, requireOwner] }, async () => {
    const daily = await prisma.$queryRaw<{ day: Date; users: bigint }[]>`
      SELECT d.day, count(DISTINCT d.u) AS users FROM (
        SELECT date_trunc('day', m."createdAt") AS day, m."authorId" AS u
          FROM "Message" m
          JOIN "User" usr ON usr.id = m."authorId" AND usr."isBot" = false
         WHERE m."createdAt" > now() - interval '30 days' AND m."authorId" IS NOT NULL
        UNION
        SELECT date_trunc('day', r."createdAt"), r."userId"
          FROM "RefreshToken" r
          JOIN "User" usr ON usr.id = r."userId" AND usr."isBot" = false
         WHERE r."createdAt" > now() - interval '30 days'
      ) d GROUP BY 1 ORDER BY 1`;

    const weekly = await prisma.$queryRaw<{ week: Date; users: bigint }[]>`
      SELECT d.week, count(DISTINCT d.u) AS users FROM (
        SELECT date_trunc('week', m."createdAt") AS week, m."authorId" AS u
          FROM "Message" m
          JOIN "User" usr ON usr.id = m."authorId" AND usr."isBot" = false
         WHERE m."createdAt" > now() - interval '12 weeks' AND m."authorId" IS NOT NULL
        UNION
        SELECT date_trunc('week', r."createdAt"), r."userId"
          FROM "RefreshToken" r
          JOIN "User" usr ON usr.id = r."userId" AND usr."isBot" = false
         WHERE r."createdAt" > now() - interval '12 weeks'
      ) d GROUP BY 1 ORDER BY 1`;

    // Cohorts: of the humans who signed up in week W, how many were active in W+1..W+4?
    const cohorts = await prisma.$queryRaw<{ cohort: Date; size: bigint; w1: bigint; w2: bigint; w3: bigint; w4: bigint }[]>`
      WITH activity AS (
        SELECT DISTINCT date_trunc('week', "createdAt") AS week, "authorId" AS u
          FROM "Message" WHERE "authorId" IS NOT NULL AND "createdAt" > now() - interval '13 weeks'
        UNION
        SELECT DISTINCT date_trunc('week', "createdAt"), "userId"
          FROM "RefreshToken" WHERE "createdAt" > now() - interval '13 weeks'
      ), signups AS (
        SELECT id, date_trunc('week', "createdAt") AS cohort
          FROM "User" WHERE "isBot" = false AND "createdAt" > now() - interval '8 weeks'
      )
      SELECT s.cohort, count(*) AS size,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity a WHERE a.u = s.id AND a.week = s.cohort + interval '1 week')) AS w1,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity a WHERE a.u = s.id AND a.week = s.cohort + interval '2 weeks')) AS w2,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity a WHERE a.u = s.id AND a.week = s.cohort + interval '3 weeks')) AS w3,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activity a WHERE a.u = s.id AND a.week = s.cohort + interval '4 weeks')) AS w4
      FROM signups s GROUP BY 1 ORDER BY 1 DESC`;

    return {
      daily: daily.map((r) => ({ day: r.day.toISOString().slice(0, 10), users: Number(r.users) })),
      weekly: weekly.map((r) => ({ week: r.week.toISOString().slice(0, 10), users: Number(r.users) })),
      cohorts: cohorts.map((c) => ({
        cohort: c.cohort.toISOString().slice(0, 10),
        size: Number(c.size),
        weeks: [Number(c.w1), Number(c.w2), Number(c.w3), Number(c.w4)],
      })),
    };
  });

  fastify.get("/attention", { preHandler: [requireAuth, requireOwner] }, async () => {
    const [pendingVideos, openReports, pendingAppeals, failedVideos] = await Promise.all([
      prisma.video.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.videoReport.count({ where: { status: "OPEN" } }),
      prisma.platformBan.count({ where: { appealStatus: "PENDING", liftedAt: null } }),
      prisma.video.count({ where: { status: "FAILED" } }),
    ]);

    const items: Array<{ kind: string; label: string; count: number; href: string; severity: string }> = [];
    if (pendingVideos > 0) {
      items.push({
        kind: "video_review",
        label: `${pendingVideos} video${pendingVideos === 1 ? "" : "s"} awaiting review`,
        count: pendingVideos,
        href: "/staff/videos",
        severity: "action",
      });
    }
    if (openReports > 0) {
      items.push({
        kind: "reports",
        label: `${openReports} open report${openReports === 1 ? "" : "s"}`,
        count: openReports,
        href: "/staff/videos",
        severity: "warn",
      });
    }
    if (pendingAppeals > 0) {
      items.push({
        kind: "appeals",
        label: `${pendingAppeals} ban appeal${pendingAppeals === 1 ? "" : "s"} awaiting a decision`,
        count: pendingAppeals,
        href: "/owner/bans",
        severity: "warn",
      });
    }
    if (failedVideos > 0) {
      items.push({
        kind: "failed_transcodes",
        label: `${failedVideos} video${failedVideos === 1 ? "" : "s"} failed to process`,
        count: failedVideos,
        href: "/staff/videos",
        severity: "info",
      });
    }
    return { items };
  });

  /**
   * Live system health. Real measurements only — process/OS metrics, a Postgres and Redis
   * round-trip, actual disk usage of the uploads volume, and the real transcode queue depth.
   */
  fastify.get("/health", { preHandler: [requireAuth, requireOwner] }, async () => {
    const dbStart = Date.now();
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    const dbLatencyMs = Date.now() - dbStart;

    const redisStart = Date.now();
    let redisOk = true;
    try {
      await redis.ping();
    } catch {
      redisOk = false;
    }
    const redisLatencyMs = Date.now() - redisStart;

    // Queue depth is the honest signal for whether transcoding is keeping up — a growing waiting
    // count means the worker is behind or down, which no HTTP healthcheck would reveal.
    let queue = { waiting: 0, active: 0, failed: 0, available: false };
    try {
      const q = getTranscodeQueue();
      const [waiting, active, failed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getFailedCount(),
      ]);
      queue = { waiting, active, failed, available: true };
    } catch {
      /* queue unreachable — reported as unavailable rather than as zeroes */
    }

    let disk: { totalBytes: number; freeBytes: number } | null = null;
    try {
      const s = await statfs(env.UPLOADS_DIR);
      disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      /* statfs unsupported or path missing */
    }

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        systemTotalBytes: os.totalmem(),
        systemFreeBytes: os.freemem(),
      },
      loadAverage: os.loadavg(),
      database: { ok: dbOk, latencyMs: dbLatencyMs },
      redis: { ok: redisOk, latencyMs: redisLatencyMs },
      transcodeQueue: queue,
      disk,
    };
  });

  /**
   * Revenue, downloads and bandwidth — the three "business" panels.
   *
   * Every figure comes from a real measurement: revenue from the local ledger (written only from
   * signature-verified Stripe webhooks), downloads from counted release fetches, bandwidth from
   * Redis byte counters on the media routes. `revenue.configured` distinguishes "no billing system
   * connected" from "connected and genuinely zero" so the dashboard never implies income exists
   * where none is being measured.
   */
  fastify.get("/business", { preHandler: [requireAuth, requireOwner] }, async () => {
    const [revenue, downloads, bandwidth] = await Promise.all([
      getRevenueStats(isBillingConfigured(), 30),
      getDownloadStats(30),
      getBandwidthSeries(30),
    ]);
    return { revenue, downloads, bandwidth };
  });

  /** Paginated user directory with search. */
  fastify.get("/users", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const query = request.query as { q?: string; page?: string; limit?: string };
    const page = Math.max(0, Number(query.page ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 25) || 25));
    const q = query.q?.trim();

    const where = q
      ? {
          isBot: false,
          OR: [
            { username: { contains: q, mode: "insensitive" as const } },
            { displayName: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : { isBot: false };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: page * limit,
        take: limit,
        include: {
          _count: { select: { messages: true, videos: true, ownedServers: true } },
          platformBans: {
            where: { scope: "ACCOUNT", liftedAt: null },
            select: { id: true, groupId: true, reason: true, expiresAt: true, appealStatus: true },
            take: 1,
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const actor = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { platformRole: true },
    });

    return {
      total,
      page,
      limit,
      // The roles THIS caller may assign, so the directory's role control offers exactly what the
      // server will accept instead of options that come back 400.
      assignableRoles: assignableRoles(actor?.platformRole),
      users: users.map((u) => ({
        ...serializeUser(u),
        // Owner-only view, so the email is included here and nowhere else — it is the identifier
        // the owner needs to actually administer an account.
        email: u.email,
        platformRole: u.platformRole,
        createdAt: u.createdAt.toISOString(),
        counts: {
          messages: u._count.messages,
          videos: u._count.videos,
          ownedServers: u._count.ownedServers,
        },
        activeBan: u.platformBans[0] ?? null,
      })),
    };
  });

  fastify.get("/users/:id", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        _count: { select: { messages: true, videos: true, ownedServers: true, memberships: true } },
        platformBans: {
          orderBy: { createdAt: "desc" },
          include: { bannedBy: { select: { id: true, username: true, displayName: true } } },
        },
        memberships: { include: { server: { select: { id: true, name: true } } }, take: 50 },
      },
    });
    if (!user) throw new NotFoundError("User not found");

    const sessions = await prisma.refreshToken.findMany({
      where: { userId: id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
    });

    return {
      ...serializeUser(user),
      email: user.email,
      platformRole: user.platformRole,
      createdAt: user.createdAt.toISOString(),
      counts: {
        messages: user._count.messages,
        videos: user._count.videos,
        ownedServers: user._count.ownedServers,
        servers: user._count.memberships,
      },
      servers: user.memberships.map((m) => m.server),
      // IPs are shown unhashed here (they are stored unhashed on RefreshToken, unlike in the ban
      // table) because the owner needs them to make an informed ban decision.
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
      bans: user.platformBans.map((b) => ({
        id: b.id,
        groupId: b.groupId,
        scope: b.scope,
        reason: b.reason,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        liftedAt: b.liftedAt?.toISOString() ?? null,
        appealStatus: b.appealStatus,
        appealText: b.appealText,
        createdAt: b.createdAt.toISOString(),
        bannedBy: b.bannedBy,
      })),
    };
  });

  fastify.patch("/users/:id/role", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = roleSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("Invalid role");

    // Every authority question — may this caller assign this role, may they touch this target — is
    // answered by the shared grant helper, so this route and /api/master/grant cannot drift into
    // enforcing different rules against the same field.
    const updated = await applyRoleGrant({
      actorId: request.userId!,
      targetId: id,
      platformRole: parsed.data.platformRole,
      actionType: "USER_ROLE_CHANGE",
    });

    // Env is only a floor for STAFF/OWNER now, so a role set here survives the target's next login.
    return { id: updated.id, platformRole: updated.platformRole, envMayOverride: false };
  });

  fastify.post("/users/:id/ban", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = banSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A ban reason is required");
    if (id === request.userId) throw new BadRequestError("You cannot ban yourself");

    const target = await prisma.user.findUnique({ where: { id }, select: { platformRole: true } });
    if (!target) throw new NotFoundError("User not found");
    // Rank, not equality. `=== "OWNER"` let an owner ban the MASTER — the one account that can
    // appoint owners — because MASTER is a different string. Anyone at owner level or above is
    // off limits from here; removing their access is a role change, not a ban.
    if (isOwner(target.platformRole)) {
      throw new BadRequestError("Owners and the master account cannot be banned");
    }

    const expiresAt = parsed.data.durationDays
      ? new Date(Date.now() + parsed.data.durationDays * 24 * 60 * 60 * 1000)
      : null;

    const result = await banUser({
      userId: id,
      actorId: request.userId!,
      reason: parsed.data.reason,
      expiresAt,
      scopes: { email: parsed.data.banEmail, ip: parsed.data.banIp, device: parsed.data.banDevice },
    });

    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "USER_BAN",
        targetType: "user",
        targetId: id,
        reason: parsed.data.reason,
      },
    });

    return { groupId: result.groupId, identifiersBanned: result.rows };
  });

  fastify.post("/bans/:groupId/lift", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { groupId } = request.params as { groupId: string };
    const count = await liftBan(groupId, request.userId!);
    if (count === 0) throw new NotFoundError("No active ban found for that group");
    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "BAN_LIFT",
        targetType: "ban",
        targetId: groupId,
        reason: null,
      },
    });
    return { lifted: count };
  });

  /** Ban list, filterable to just those with an appeal waiting. */
  fastify.get("/bans", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const query = request.query as { appeals?: string };
    const onlyAppeals = query.appeals === "true";

    const bans = await prisma.platformBan.findMany({
      where: {
        scope: "ACCOUNT",
        ...(onlyAppeals ? { appealStatus: "PENDING", liftedAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true, email: true } },
        bannedBy: { select: { id: true, username: true, displayName: true } },
      },
    });

    // How many identifiers each ban action covered, so the owner can see the blast radius of a
    // device/IP ban before deciding an appeal.
    const groupCounts = await prisma.platformBan.groupBy({
      by: ["groupId"],
      where: { groupId: { in: bans.map((b) => b.groupId) } },
      _count: { _all: true },
    });
    const countByGroup = new Map(groupCounts.map((g) => [g.groupId, g._count._all]));

    return bans.map((b) => ({
      id: b.id,
      groupId: b.groupId,
      reason: b.reason,
      expiresAt: b.expiresAt?.toISOString() ?? null,
      liftedAt: b.liftedAt?.toISOString() ?? null,
      appealStatus: b.appealStatus,
      appealText: b.appealText,
      appealedAt: b.appealedAt?.toISOString() ?? null,
      appealResponse: b.appealResponse,
      createdAt: b.createdAt.toISOString(),
      user: b.user,
      bannedBy: b.bannedBy,
      identifierCount: countByGroup.get(b.groupId) ?? 1,
    }));
  });

  fastify.post("/bans/:groupId/appeal", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { groupId } = request.params as { groupId: string };
    const parsed = appealResolveSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A response is required");

    await resolveAppeal(groupId, request.userId!, parsed.data.approve, parsed.data.response);
    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: parsed.data.approve ? "APPEAL_APPROVE" : "APPEAL_DENY",
        targetType: "ban",
        targetId: groupId,
        reason: parsed.data.response,
      },
    });
    return { ok: true };
  });
}

/** Counts per calendar day over the last `days`, oldest first, with quiet days present as zero — a
 * chart that silently omits empty days misrepresents the shape of the data. */
function bucketByDay(dates: Date[], days: number): Array<{ date: string; count: number }> {
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), 0);
  }
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}
