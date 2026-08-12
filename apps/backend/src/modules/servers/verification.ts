import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { ForbiddenError } from "../../lib/errors.js";
import { computeEffectivePermissions } from "../../permissions/permissionService.js";

/**
 * Verification level — the gate a member has to clear before they can post.
 *
 * ## Enforced, not decorative
 *
 * This runs inside the send path. A verification level that is only stored and rendered in a
 * settings panel is worse than not having one: an operator turns it on believing raiders are now
 * blocked, and nothing changes. Discord's ladder is used unchanged because it is well understood
 * and each rung maps onto a signal this codebase already records.
 *
 * | Level  | Requirement |
 * |--------|-------------|
 * | NONE   | anyone |
 * | LOW    | verified email |
 * | MEDIUM | ...and the Lumina account is older than 5 minutes |
 * | HIGH   | ...and they have been in THIS server longer than 10 minutes |
 *
 * ## Who is exempt
 *
 * The server owner, and anyone with MANAGE_SERVER or ADMINISTRATOR. Without that, an operator who
 * has not verified their own email can lock themselves out of their own server by raising the
 * level — the setting would apply to the person setting it, with no way back except the database.
 *
 * ## Cost
 *
 * Returns after ONE indexed lookup when the level is NONE, which is every server by default. The
 * extra queries only happen on servers that have deliberately turned this on.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export async function assertPassesVerification(userId: string, serverId: string): Promise<void> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { verificationLevel: true, ownerId: true },
  });
  // The overwhelmingly common case, and the reason this is cheap enough to sit in the send path.
  if (!server || server.verificationLevel === "NONE") return;
  if (server.ownerId === userId) return;

  const effective = await computeEffectivePermissions(userId, serverId);
  if (
    (effective & Permissions.ADMINISTRATOR) !== 0n ||
    (effective & Permissions.MANAGE_SERVER) !== 0n
  ) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true, createdAt: true },
  });
  if (!user) throw new ForbiddenError("Account not found");

  if (!user.emailVerifiedAt) {
    throw new ForbiddenError(
      "This server requires a verified email address before you can post. Check your inbox, or resend the link from Settings.",
    );
  }
  if (server.verificationLevel === "LOW") return;

  const accountAge = Date.now() - user.createdAt.getTime();
  if (accountAge < FIVE_MINUTES_MS) {
    throw new ForbiddenError(
      "This server requires your account to be at least 5 minutes old before you can post.",
    );
  }
  if (server.verificationLevel === "MEDIUM") return;

  const membership = await prisma.membership.findFirst({
    where: { userId, serverId },
    select: { joinedAt: true },
  });
  // No membership row should be impossible here (requireMembership ran first), but treating a
  // missing row as "just joined" fails closed rather than silently granting HIGH.
  const memberAge = membership ? Date.now() - membership.joinedAt.getTime() : 0;
  if (memberAge < TEN_MINUTES_MS) {
    throw new ForbiddenError(
      "This server requires you to be a member for 10 minutes before you can post.",
    );
  }
}
