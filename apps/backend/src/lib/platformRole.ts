import type { PlatformRole } from "@prisma/client";

/**
 * Rank of each platform role. The ladder is strictly ordered — an OWNER can do everything an
 * EXECUTIVE can, and so on down — so authority checks compare ranks rather than testing equality.
 * Testing `role === "MODERATOR"` is the bug this exists to prevent: it silently locks everyone
 * senior out of the surface they are most responsible for.
 *
 * The order here must match the Postgres enum (see the staff_ladder migration). They are two
 * statements of the same ladder, and only this one decides who may do what.
 */
const RANK: Record<PlatformRole, number> = {
  USER: 0,
  MODERATOR: 1,
  ADMIN: 2,
  EXECUTIVE: 3,
  OWNER: 4,
  MASTER: 5,
};

/** Lowest to highest. Used where the whole ladder is needed rather than one comparison. */
export const ROLE_LADDER: PlatformRole[] = ["USER", "MODERATOR", "ADMIN", "EXECUTIVE", "OWNER", "MASTER"];

export function hasPlatformRole(role: PlatformRole | undefined | null, required: PlatformRole): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[required];
}

/** Any Lumina staff rank at all — the floor for the moderation queues, and what the public badge
 * on a profile is rendered from. */
export function isStaff(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "MODERATOR");
}

/** ADMIN or above — the people surfaces: the user directory, bans, appeals, linked accounts. */
export function isAdmin(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "ADMIN");
}

/** EXECUTIVE or above — how the platform is doing: revenue, engagement, downloads, the MOTD. */
export function isExecutive(role: PlatformRole | undefined | null): boolean {
  return hasPlatformRole(role, "EXECUTIVE");
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
 * Two rules, both deliberate:
 *
 *  - Only an OWNER or the MASTER may assign anything at all. Admins and executives outrank
 *    moderators but do not appoint them; handing out authority stays owner business, which is the
 *    rule that was already in force when STAFF was the only staff rank.
 *  - You may only assign STRICTLY BELOW yourself, so an owner cannot appoint another owner. That
 *    keeps a compromised account from spreading privilege sideways to a peer it cannot then undo.
 *
 * MASTER is absent from every list on purpose — it comes solely from the MASTER_EMAIL env var, so
 * no API path can create one.
 */
export function assignableRoles(actor: PlatformRole | undefined | null): PlatformRole[] {
  if (!actor || !isOwner(actor)) return [];
  return ROLE_LADDER.filter((role) => RANK[role] < RANK[actor] && role !== "MASTER");
}
