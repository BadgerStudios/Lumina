import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { BanScope } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";

/**
 * A banned account keeps its access token working until that token expires, because verifying a ban
 * on every request would mean a database round trip per request. This cache closes that window
 * cheaply: one Redis GET per authenticated request, with the DB consulted only on a miss.
 *
 * 30s is chosen so a ban takes hold almost immediately (rather than up to the 15-minute access-token
 * TTL) without the read cost of checking Postgres each time. Banning also revokes refresh tokens, so
 * the session cannot be renewed once it lapses.
 */
const BAN_CACHE_TTL_SEC = 30;
const banCacheKey = (userId: string) => `banstate:${userId}`;

export interface BanCheckResult {
  banned: boolean;
  reason?: string;
  scope?: BanScope;
  expiresAt?: Date | null;
  banId?: string;
  appealStatus?: string;
}

/** A ban row only counts if it hasn't been lifted and hasn't expired. Centralised because getting
 * this predicate wrong in one place silently un-bans (or permanently bans) everyone. */
function activeBanWhere() {
  return {
    liftedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

/**
 * Hashes an identifier before it is stored or compared.
 *
 * Emails, IPs and fingerprints are all personal data, and a ban list is exactly the table most
 * likely to be dumped and shared. Storing one-way hashes means the list is still fully usable for
 * matching — the only operation it needs — while a leak doesn't hand over a list of people's
 * addresses and IPs. Salted with the JWT secret so hashes aren't reversible via a rainbow table of
 * common IPs, which a bare SHA-256 of "203.0.113.4" absolutely would be.
 */
export function hashIdentifier(value: string): string {
  const salt = process.env.JWT_ACCESS_SECRET ?? "";
  return createHash("sha256").update(`${salt}:${value.trim().toLowerCase()}`).digest("hex");
}

/**
 * Checks whether a signup/login attempt matches any active ban, by any identifier.
 *
 * Called on register and login — the two moments where evasion is actually attempted. Returns the
 * matching ban so the client can be told which appeal applies rather than a bare "denied".
 */
export async function checkIdentifierBans(params: {
  email?: string | null;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
  userId?: string | null;
}): Promise<BanCheckResult> {
  const or: Array<Record<string, unknown>> = [];
  if (params.userId) or.push({ scope: "ACCOUNT", userId: params.userId });
  if (params.email) or.push({ scope: "EMAIL", email: hashIdentifier(params.email) });
  if (params.ipAddress) or.push({ scope: "IP", ipAddress: hashIdentifier(params.ipAddress) });
  if (params.deviceFingerprint) {
    or.push({ scope: "DEVICE", deviceFingerprint: hashIdentifier(params.deviceFingerprint) });
  }
  if (or.length === 0) return { banned: false };

  const ban = await prisma.platformBan.findFirst({
    where: { ...activeBanWhere(), OR: or },
    // Prefer an ACCOUNT match: it's the most specific and carries the most meaningful appeal.
    orderBy: { scope: "asc" },
  });
  if (!ban) return { banned: false };

  return {
    banned: true,
    reason: ban.reason,
    scope: ban.scope,
    expiresAt: ban.expiresAt,
    banId: ban.id,
    appealStatus: ban.appealStatus,
  };
}

/** Per-request account ban check, Redis-cached. Falls back to the database when Redis is
 * unavailable rather than assuming "not banned" — failing open on an authorization check would
 * quietly disable every ban the moment Redis hiccups. */
export async function isUserBanned(userId: string): Promise<boolean> {
  try {
    const cached = await redis.get(banCacheKey(userId));
    if (cached !== null) return cached === "1";
  } catch {
    /* fall through to the database */
  }

  const ban = await prisma.platformBan.findFirst({
    where: { ...activeBanWhere(), scope: "ACCOUNT", userId },
    select: { id: true },
  });
  const banned = Boolean(ban);

  try {
    await redis.set(banCacheKey(userId), banned ? "1" : "0", "EX", BAN_CACHE_TTL_SEC);
  } catch {
    /* caching is an optimisation, not a requirement */
  }
  return banned;
}

async function invalidateBanCache(userId: string): Promise<void> {
  try {
    await redis.del(banCacheKey(userId));
  } catch {
    /* the 30s TTL is the backstop */
  }
}

export interface BanUserParams {
  userId: string;
  actorId: string;
  reason: string;
  expiresAt: Date | null;
  /** Which identifiers to ban alongside the account itself. */
  scopes: { email: boolean; ip: boolean; device: boolean };
}

/**
 * Bans a user and, optionally, the identifiers they're known by.
 *
 * Writes one row per identifier sharing a `groupId`, so the dashboard can show a single action and
 * lift it as a unit. Known IPs and device fingerprints come from the user's RefreshToken rows, which
 * already record one entry per signed-in device — no separate device table needed.
 *
 * Also revokes every refresh token: without that, a banned user's session simply renews itself and
 * the ban only takes effect whenever they happen to log out.
 */
export async function banUser(params: BanUserParams): Promise<{ groupId: string; rows: number }> {
  const { userId, actorId, reason, expiresAt, scopes } = params;
  const groupId = randomUUID();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new Error("User not found");

  const rows: Array<{
    groupId: string;
    scope: BanScope;
    userId?: string;
    email?: string;
    ipAddress?: string;
    deviceFingerprint?: string;
    reason: string;
    bannedById: string;
    expiresAt: Date | null;
  }> = [
    { groupId, scope: "ACCOUNT", userId, reason, bannedById: actorId, expiresAt },
  ];

  if (scopes.email) {
    rows.push({
      groupId,
      scope: "EMAIL",
      email: hashIdentifier(user.email),
      reason,
      bannedById: actorId,
      expiresAt,
    });
  }

  if (scopes.ip || scopes.device) {
    // Only recent sessions: an IP from months ago has very likely been reassigned to someone else,
    // and banning it would hit a stranger.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sessions = await prisma.refreshToken.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { ipAddress: true, deviceFingerprint: true },
      take: 50,
    });

    if (scopes.ip) {
      const ips = new Set(sessions.map((s) => s.ipAddress).filter(Boolean) as string[]);
      for (const ip of ips) {
        rows.push({
          groupId,
          scope: "IP",
          ipAddress: hashIdentifier(ip),
          reason,
          bannedById: actorId,
          expiresAt,
        });
      }
    }
    if (scopes.device) {
      const devices = new Set(
        sessions.map((s) => s.deviceFingerprint).filter(Boolean) as string[],
      );
      for (const fp of devices) {
        rows.push({
          groupId,
          scope: "DEVICE",
          deviceFingerprint: hashIdentifier(fp),
          reason,
          bannedById: actorId,
          expiresAt,
        });
      }
    }
  }

  await prisma.$transaction([
    prisma.platformBan.createMany({ data: rows }),
    // Kill every existing session so the ban can't be outlived by a token refresh.
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await invalidateBanCache(userId);
  return { groupId, rows: rows.length };
}

/** Lifts every row in a ban group. */
export async function liftBan(groupId: string, actorId: string): Promise<number> {
  const bans = await prisma.platformBan.findMany({
    where: { groupId, liftedAt: null },
    select: { userId: true },
  });
  const result = await prisma.platformBan.updateMany({
    where: { groupId, liftedAt: null },
    data: { liftedAt: new Date(), liftedById: actorId },
  });
  for (const b of bans) {
    if (b.userId) await invalidateBanCache(b.userId);
  }
  return result.count;
}

/**
 * Records a banned user's appeal.
 *
 * Appeals exist because IP and DEVICE matching genuinely catches innocent people — a shared house,
 * an office NAT, a corporate-imaged laptop that fingerprints identically to thousands of others. A
 * ban system without a route back is a bug, not a policy.
 */
export async function submitAppeal(banId: string, text: string): Promise<void> {
  const ban = await prisma.platformBan.findUnique({ where: { id: banId } });
  if (!ban) throw new Error("Ban not found");
  if (ban.appealStatus === "PENDING") throw new Error("An appeal is already under review");
  if (ban.appealStatus === "DENIED") throw new Error("This ban has already been appealed");

  await prisma.platformBan.updateMany({
    where: { groupId: ban.groupId },
    data: { appealStatus: "PENDING", appealText: text, appealedAt: new Date() },
  });
}

export async function resolveAppeal(
  groupId: string,
  actorId: string,
  approve: boolean,
  response: string,
): Promise<void> {
  await prisma.platformBan.updateMany({
    where: { groupId },
    data: {
      appealStatus: approve ? "APPROVED" : "DENIED",
      appealResponse: response,
      appealResolvedAt: new Date(),
      // Approving an appeal lifts the ban in the same write — an "approved" appeal that left the
      // user banned would be the worst possible outcome of this flow.
      ...(approve ? { liftedAt: new Date(), liftedById: actorId } : {}),
    },
  });

  if (approve) {
    const bans = await prisma.platformBan.findMany({
      where: { groupId, userId: { not: null } },
      select: { userId: true },
    });
    for (const b of bans) if (b.userId) await invalidateBanCache(b.userId);
  }
}
