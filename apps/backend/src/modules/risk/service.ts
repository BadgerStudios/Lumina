import type { FastifyRequest } from "fastify";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { assessRequest, type IpAssessment } from "../../lib/ipIntel.js";
import { recordFlag } from "../flags/service.js";
import { ForbiddenError } from "../../lib/errors.js";

/**
 * Connection-origin risk, applied where abuse actually costs something.
 *
 * ## The rule, and why it is this narrow
 *
 * A brand-new account on an anonymised connection (Tor, a commercial VPN, a hosting provider)
 * cannot upload video, buy ads, or open a DM with someone who isn't already a friend. That is the
 * whole restriction. Reading, posting in servers, and continuing existing conversations are all
 * untouched.
 *
 * Both halves of the condition matter:
 *
 *  - **VPN alone is not a signal worth acting on.** Plenty of ordinary people are always behind
 *    one — corporate laptops, privacy-minded users, whole countries. Restricting on that alone
 *    punishes a large group of legitimate users to inconvenience a small group of abusers.
 *  - **New alone is not either**, or every genuine signup gets a worse first day.
 *
 * Together they describe the actual pattern: throwaway accounts made in bulk from somewhere
 * untraceable, which is what bulk spam signups and ban evasion look like.
 *
 * ## It expires on its own
 *
 * The restriction is computed from account age and the current connection, never stored. There is
 * no flag to clear and no job to run, so it cannot get stuck on — the two ways out are waiting, or
 * turning the VPN off. Both are things the affected person can do without contacting anyone, which
 * is the difference between a speed bump and a support ticket.
 *
 * ## What it does not do
 *
 * It will not stop a determined ban evader. Residential proxies are indistinguishable from real
 * users without paid data, and anyone persistent enough to have been banned twice will find one.
 * This raises the cost of the casual case; `checkIdentifierBans` on device and email remains the
 * lever for the rest.
 */

/** How long an account is treated as new. Three days is long enough to be inconvenient for
 * bulk-created throwaways and short enough that a real person who signed up on a VPN is barely
 * affected — and they can lift it instantly by turning the VPN off. */
export const TRUST_WINDOW_DAYS = 3;

const AGE_CACHE_PREFIX = "risk:accountage:";
/** createdAt never changes, so this only ever needs to be read once per account per window. */
const AGE_CACHE_TTL_SEC = 3600;

export interface RiskAssessment extends IpAssessment {
  /** True when this specific request should be refused a sensitive action. */
  restricted: boolean;
  accountAgeDays: number | null;
}

async function accountAgeDays(userId: string): Promise<number | null> {
  const key = `${AGE_CACHE_PREFIX}${userId}`;
  try {
    const cached = await redis.get(key);
    if (cached !== null) return Number(cached);
  } catch {
    /* fall through to the database */
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  if (!user) return null;
  const days = (Date.now() - user.createdAt.getTime()) / 86_400_000;

  try {
    await redis.set(key, String(days), "EX", AGE_CACHE_TTL_SEC);
  } catch {
    /* caching is an optimisation */
  }
  return days;
}

export async function assessRisk(request: FastifyRequest, userId: string): Promise<RiskAssessment> {
  const ip = assessRequest(request);
  if (!ip.anonymised) return { ...ip, restricted: false, accountAgeDays: null };

  const age = await accountAgeDays(userId);
  // A user we cannot age is NOT treated as new. Failing closed here would restrict people during a
  // database hiccup, on a check whose entire purpose is to be a mild speed bump.
  const restricted = age !== null && age < TRUST_WINDOW_DAYS;
  return { ...ip, restricted, accountAgeDays: age };
}

/**
 * Throws if this request may not perform a sensitive action.
 *
 * Records the flag only when it actually restricts something. Writing one on every request from
 * every VPN user would bury the interesting rows under thousands of uninteresting ones — the
 * "we noticed" case is recorded once at signup instead (see recordOriginFlag).
 */
export async function assertTrustedOrigin(
  request: FastifyRequest,
  userId: string,
  action: string,
): Promise<void> {
  const risk = await assessRisk(request, userId);
  if (!risk.restricted) return;

  await recordFlag({
    userId,
    ipAddress: request.ip,
    deviceFingerprint: deviceHeader(request),
    reasonCode: "NEW_ACCOUNT_ANONYMISED_ORIGIN",
    detail: `${action} blocked; origin=${risk.risk}, accountAgeDays=${risk.accountAgeDays?.toFixed(2)}`,
  });

  throw new ForbiddenError(
    "New accounts can't upload videos, buy ads or message people they don't know while connected " +
      "through a VPN or Tor. Turn it off, or come back in a few days.",
  );
}

/** Records that a signup or login came from an anonymised connection. Never blocks anything —
 * severity INFO — so it is safe to call on every auth event. */
export async function recordOriginFlag(
  request: FastifyRequest,
  params: { userId?: string | null; email?: string | null },
): Promise<void> {
  const ip = assessRequest(request);
  if (!ip.anonymised) return;
  await recordFlag({
    userId: params.userId ?? null,
    email: params.email ?? null,
    ipAddress: request.ip,
    deviceFingerprint: deviceHeader(request),
    reasonCode: "IP_ANONYMISED",
    detail: `origin=${ip.risk}${ip.note ? ` (${ip.note})` : ""}`,
  });
}

function deviceHeader(request: FastifyRequest): string | null {
  const raw = request.headers["x-device-fingerprint"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value ? value : null;
}
