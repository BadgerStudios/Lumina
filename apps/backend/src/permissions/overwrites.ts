/**
 * Channel permission overwrite resolution.
 *
 * Kept as a pure function, separate from permissionService's database access, for one reason: this
 * is the piece where a subtle ordering mistake silently grants access rather than failing loudly.
 * A pure function can be exhaustively unit-tested against the adversarial cases (a role that
 * allows what @everyone denies, and the reverse) with no database, no fixtures, and no chance of a
 * passing test that only reflects the seed data.
 */

export type OverwriteTargetType = "ROLE" | "USER";

export interface Overwrite {
  targetType: OverwriteTargetType;
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export interface OverwriteContext {
  /** Server-wide effective bitfield, before any channel adjustment. */
  base: bigint;
  /** Id of the server's `isDefault` (@everyone) role. */
  everyoneRoleId: string;
  /** Ids of roles explicitly assigned to the member. Must NOT include @everyone. */
  roleIds: string[];
  userId: string;
}

/**
 * Resolve the member's effective permissions inside one channel.
 *
 * This is Discord's documented algorithm, deliberately reproduced rather than reinvented — its
 * ordering is load-bearing and its edge cases are already well understood by anyone who has
 * administered a Discord server, which is exactly the audience configuring this.
 *
 * The order is:
 *
 *   1. the @everyone overwrite, applied on its own
 *   2. every role overwrite the member holds, accumulated into a single allow/deny pair and
 *      applied together
 *   3. the member-specific overwrite, last, so it beats everything
 *
 * ## Why steps 1 and 2 cannot be merged
 *
 * It is tempting to fold @everyone into the role loop by treating it as one more role. That is
 * wrong, and wrong in the permissive direction — the dangerous one. Take a channel where
 * @everyone *allows* SEND_MESSAGES and a "Muted" role *denies* it, which is precisely how muting
 * is configured. Merged, the accumulated pair is allow={SEND}, deny={SEND}; applying `&= ~deny`
 * then `|= allow` re-grants the bit and the muted member can post. Applied in order, the deny
 * lands after the allow and the member stays muted.
 *
 * Within step 2 the accumulation itself is order-independent, so no role sorting is needed. Note
 * that the allow is applied after the deny *inside* that step, so a member holding two roles where
 * one allows a bit and another denies it ends up ALLOWED — the grant wins. That is Discord's
 * behaviour, and it is why muting is configured as an @everyone allow plus a Muted-role deny
 * (step 1 vs step 2) rather than as two competing roles, which would not hold.
 *
 * ADMINISTRATOR and server ownership are handled by the caller and never reach this function —
 * they bypass overwrites entirely, so a channel cannot lock out the person who owns the server.
 */
export function applyChannelOverwrites(overwrites: Overwrite[], ctx: OverwriteContext): bigint {
  let permissions = ctx.base;

  const everyone = overwrites.find((o) => o.targetType === "ROLE" && o.targetId === ctx.everyoneRoleId);
  if (everyone) {
    permissions &= ~everyone.deny;
    permissions |= everyone.allow;
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  const held = new Set(ctx.roleIds);
  for (const o of overwrites) {
    if (o.targetType !== "ROLE") continue;
    if (o.targetId === ctx.everyoneRoleId) continue; // already applied, in its own step
    if (!held.has(o.targetId)) continue;
    roleAllow |= o.allow;
    roleDeny |= o.deny;
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const member = overwrites.find((o) => o.targetType === "USER" && o.targetId === ctx.userId);
  if (member) {
    permissions &= ~member.deny;
    permissions |= member.allow;
  }

  return permissions;
}
