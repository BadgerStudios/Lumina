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
  MODERATOR: 1,
  ADMIN: 2,
  EXECUTIVE: 3,
  OWNER: 4,
  MASTER: 5,
};

/** Lowest to highest, for the places that need the whole ladder rather than one comparison. */
export const ROLE_LADDER: PlatformRole[] = ["USER", "MODERATOR", "ADMIN", "EXECUTIVE", "OWNER", "MASTER"];

export function hasRole(role: PlatformRole | undefined | null, required: PlatformRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[required];
}

/** Any Lumina staff rank at all — the floor for the moderation queues and the console. */
export const isStaff = (role: PlatformRole | undefined | null) => hasRole(role, "MODERATOR");
/** ADMIN or above — the people surfaces: user directory, bans, appeals, linked accounts. */
export const isAdmin = (role: PlatformRole | undefined | null) => hasRole(role, "ADMIN");
/** EXECUTIVE or above — how the platform is doing: stats, revenue, downloads, the MOTD. */
export const isExecutive = (role: PlatformRole | undefined | null) => hasRole(role, "EXECUTIVE");
export const isOwner = (role: PlatformRole | undefined | null) => hasRole(role, "OWNER");
export const isMaster = (role: PlatformRole | undefined | null) => hasRole(role, "MASTER");
