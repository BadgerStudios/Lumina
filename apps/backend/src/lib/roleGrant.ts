import type { PlatformRole } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { assignableRoles } from "./platformRole.js";

/**
 * The single implementation of "change someone's platform role".
 *
 * Both the master console (/api/master/grant) and the owner user directory
 * (/api/owner/users/:id/role) change the same field, and when they each carried their own checks
 * the weaker one became the real security boundary: the owner route validated only the NEW role,
 * so an owner could promote a second owner or demote the master — neither of which the master
 * route permits. Authority questions are answered here, once, for every caller.
 */
export async function applyRoleGrant(opts: {
  actorId: string;
  targetId: string;
  platformRole: PlatformRole;
  /** Recorded on the audit entry so the two surfaces stay distinguishable after the fact. */
  actionType: string;
}): Promise<{ id: string; username: string; platformRole: PlatformRole }> {
  const actor = await prisma.user.findUnique({
    where: { id: opts.actorId },
    select: { platformRole: true },
  });

  // What the CALLER may assign, not what the schema allows: an owner can appoint staff, only the
  // master can appoint owners, and MASTER is assignable by nobody.
  const allowed = assignableRoles(actor?.platformRole);
  if (!allowed.includes(opts.platformRole)) {
    throw new BadRequestError(`You cannot assign the ${opts.platformRole} role`);
  }

  const target = await prisma.user.findUnique({
    where: { id: opts.targetId },
    select: { id: true, platformRole: true, isBot: true, username: true },
  });
  if (!target) throw new NotFoundError("User not found");
  if (target.isBot) throw new BadRequestError("Bots cannot hold platform roles");
  if (target.id === opts.actorId) throw new BadRequestError("You cannot change your own role");

  // The master's role comes from MASTER_EMAIL and is restored at their next login regardless, so
  // refuse rather than pretend it worked — and so a compromised owner cannot lock the master out
  // of the console in the meantime.
  if (target.platformRole === "MASTER") {
    throw new BadRequestError(
      "The master account's role is set by MASTER_EMAIL and cannot be changed here",
    );
  }

  // Demoting a peer is the sideways-escalation move: one compromised owner should not be able to
  // remove the others. Only a strictly higher rank may change someone who already holds a role.
  if (!allowed.includes(target.platformRole)) {
    throw new BadRequestError(`You cannot change the role of a ${target.platformRole}`);
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { platformRole: opts.platformRole },
    select: { id: true, username: true, platformRole: true },
  });

  await prisma.staffAuditLog.create({
    data: {
      actorId: opts.actorId,
      actionType: opts.actionType,
      targetType: "user",
      targetId: target.id,
      reason: `${target.platformRole} -> ${opts.platformRole}`,
    },
  });

  return updated;
}
