import type { PlatformRole } from "@prisma/client";

/**
 * Rank of each platform role. The ladder is strictly ordered — OWNER can do everything STAFF can —
 * so authority checks compare ranks rather than testing equality. Testing `role === "STAFF"` is the
 * bug this exists to prevent: it silently locks the owner out of every staff surface.
 */
const RANK: Record<PlatformRole, number> = {
  USER: 0,
  STAFF: 1,
  OWNER: 2,
  MASTER: 3,
};

export function hasPlatformRole(role: PlatformRole | undefined | null, required: PlatformRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[required];
}

export function isStaff(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "STAFF");
}

export function isOwner(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "OWNER");
}

export function isMaster(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "MASTER");
}

/**
 * Which roles a given actor is allowed to assign.
 *
 * MASTER is absent from every list on purpose — it is granted solely by the MASTER_EMAIL env var, so
 * no API path can create one. An owner can appoint staff but cannot appoint another owner, which
 * keeps privilege escalation from spreading sideways if an owner account is ever compromised.
 */
export function assignableRoles(actor: PlatformRole | undefined | null): PlatformRole[] {
  if (isMaster(actor)) return ["USER", "STAFF", "OWNER"];
  if (isOwner(actor)) return ["USER", "STAFF"];
  return [];
}
