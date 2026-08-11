import type { PlatformRole } from "@lumina/shared";

/**
 * Client-side mirror of the backend's rank comparison (apps/backend/src/lib/platformRole.ts).
 *
 * This exists because the same bug was made twice: the ladder is strictly ordered, so authority is a
 * `>=` on rank, but it is very easy to write `role === "OWNER"` — which locks the MASTER out of every
 * owner surface, since MASTER is above OWNER and not equal to it. That is precisely what happened to
 * the owner console, which showed its master "Owner access required".
 *
 * Presentation only. Every privileged route enforces the same ladder server-side; nothing here is a
 * security boundary.
 */
const RANK: Record<PlatformRole, number> = {
  USER: 0,
  STAFF: 1,
  OWNER: 2,
  MASTER: 3,
};

export function hasRole(role: PlatformRole | undefined | null, required: PlatformRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[required];
}

export const isStaff = (role: PlatformRole | undefined | null) => hasRole(role, "STAFF");
export const isOwner = (role: PlatformRole | undefined | null) => hasRole(role, "OWNER");
export const isMaster = (role: PlatformRole | undefined | null) => hasRole(role, "MASTER");
