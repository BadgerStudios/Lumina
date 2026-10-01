import { createHash } from "node:crypto";
import { getBlockReason } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { UNDERAGE_SIGNUP_COOLDOWN_DAYS } from "../age/service.js";

/** Same salted hashing as the ban table — a flag row is analytics and support context, and neither
 * needs to be able to identify anyone from a leaked dump. */
function hashIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const salt = process.env.JWT_ACCESS_SECRET ?? "";
  return createHash("sha256").update(`${salt}:${value.trim().toLowerCase()}`).digest("hex");
}

/**
 * Records why something was blocked, restricted or errored.
 *
 * Never throws: a flag is a record of an event that has already been decided, so failing to write
 * one must not turn a clean rejection into a 500.
 */
/**
 * Whether this device is currently barred from creating new accounts.
 *
 * Registration only — an existing account on the same device signs in normally. Devices are shared,
 * so blocking access rather than signup would take out everyone in a household over one person's
 * attempt.
 */
/** The salted hash used for every identifier column, exported so a review can place a device on cooldown. */
export function hashForFlag(value: string | null | undefined): string | null {
  return hashIdentifier(value);
}

export async function isSignupBlocked(
  deviceFingerprint: string | null | undefined,
): Promise<{ blocked: boolean; reasonCode?: string }> {
  const deviceHash = hashIdentifier(deviceFingerprint);
  if (!deviceHash) return { blocked: false };

  const cutoff = new Date(Date.now() - UNDERAGE_SIGNUP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const flag = await prisma.accountFlag.findFirst({
    where: {
      deviceHash,
      active: true,
      reasonCode: { in: ["AGE_UNDER_MINIMUM", "AGE_SIGNUP_COOLDOWN"] },
      // Expires by age rather than by a scheduled job — nothing has to run for the block to lift,
      // which means it cannot get stuck on because a sweep failed.
      createdAt: { gte: cutoff },
    },
    select: { reasonCode: true },
  });
  if (!flag) return { blocked: false };
  return { blocked: true, reasonCode: "AGE_SIGNUP_COOLDOWN" };
}

/** Age refusals are the one kind of flag the owner reviews by hand (a typo or a real under-age
 * attempt), so they keep plaintext provenance like an uploaded video does. Everything else stays
 * hash-only. Purged after AGE_PROVENANCE_DAYS by the worker. */
export const AGE_PROVENANCE_CODES = new Set(["AGE_UNDER_MINIMUM", "AGE_MISMATCH", "AGE_SIGNUP_COOLDOWN"]);
export const AGE_PROVENANCE_DAYS = 90;

export async function recordFlag(params: {
  userId?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
  reasonCode: string;
  detail?: string | null;
  /** Plaintext provenance; stored only for AGE_PROVENANCE_CODES. */
  provenance?: { userAgent?: string | null; country?: string | null; clientType?: string | null };
}): Promise<string | null> {
  try {
    const reason = getBlockReason(params.reasonCode);
    const keep = AGE_PROVENANCE_CODES.has(params.reasonCode);
    const row = await prisma.accountFlag.create({
      select: { id: true },
      data: {
        userId: params.userId ?? null,
        email: hashIdentifier(params.email),
        ipHash: hashIdentifier(params.ipAddress),
        deviceHash: hashIdentifier(params.deviceFingerprint),
        ...(keep
          ? {
              ipAddress: params.ipAddress?.slice(0, 64) ?? null,
              userAgent: params.provenance?.userAgent?.slice(0, 400) ?? null,
              country: params.provenance?.country?.slice(0, 2) ?? null,
              clientType: params.provenance?.clientType?.slice(0, 32) ?? null,
            }
          : {}),
        reasonCode: params.reasonCode,
        detail: params.detail?.slice(0, 500) ?? null,
        severity: reason?.severity ?? "INFO",
        // Only a genuine block stays "active" and needs resolving; informational events are history.
        active: reason ? reason.severity !== "INFO" : false,
      },
    });
    return row.id;
  } catch {
    /* a missing audit row must never break the request that caused it */
    return null;
  }
}

/** Clears the plaintext IP / user agent / country / client kept on age flags once they are older
 * than AGE_PROVENANCE_DAYS. The hashes stay, so the device and IP blocks keep working. */
export async function purgeExpiredFlagProvenance(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AGE_PROVENANCE_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.accountFlag.updateMany({
    where: {
      createdAt: { lt: cutoff },
      provenancePurgedAt: null,
      OR: [
        { ipAddress: { not: null } },
        { userAgent: { not: null } },
        { country: { not: null } },
        { clientType: { not: null } },
      ],
    },
    data: { ipAddress: null, userAgent: null, country: null, clientType: null, provenancePurgedAt: now },
  });
  return count;
}
