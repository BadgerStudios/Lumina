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

export async function recordFlag(params: {
  userId?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
  reasonCode: string;
  detail?: string | null;
}): Promise<void> {
  try {
    const reason = getBlockReason(params.reasonCode);
    await prisma.accountFlag.create({
      data: {
        userId: params.userId ?? null,
        email: hashIdentifier(params.email),
        ipHash: hashIdentifier(params.ipAddress),
        deviceHash: hashIdentifier(params.deviceFingerprint),
        reasonCode: params.reasonCode,
        detail: params.detail?.slice(0, 500) ?? null,
        severity: reason?.severity ?? "INFO",
        // Only a genuine block stays "active" and needs resolving; informational events are history.
        active: reason ? reason.severity !== "INFO" : false,
      },
    });
  } catch {
    /* a missing audit row must never break the request that caused it */
  }
}
