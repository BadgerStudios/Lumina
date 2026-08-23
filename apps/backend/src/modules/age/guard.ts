import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { prisma } from "../../db/prisma.js";
import { BlockedError, UnauthorizedError } from "../../lib/errors.js";

/**
 * Restricts a route to accounts confirmed to be adults.
 *
 * Used on the whole video feed. "Confirmed" is the operative word: an account with no age on record
 * fails this, not just one known to be a minor. Treating unknown as adult would mean every account
 * created before age collection existed silently kept access, which is the opposite of what an age
 * restriction is for.
 *
 * Enforced per request rather than trusted from the token, so answering the age prompt grants access
 * immediately and a restriction applies immediately too.
 */
export const requireAdult: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!request.userId) throw new UnauthorizedError();
  const user = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { isMinor: true, ageRecordedAt: true },
  });
  if (!user || user.ageRecordedAt === null) throw new BlockedError("AGE_MISSING");
  if (user.isMinor) throw new BlockedError("AGE_UNDER_MINIMUM");
};

/**
 * Stronger gate for the real-money surface (creator payouts / monetization): an adult who has ALSO
 * cleared a document identity step — Persona document+selfie, or an admin-reviewed selfie
 * (`identityVerifiedAt` set). Self-declared adulthood is enough to consume the platform (the feed,
 * store, tips out); it is NOT enough to be paid, where a typed-in birthday can't stand in for KYC.
 *
 * Fails closed like requireAdult, and by the same reasoning: unknown age and minors are blocked, and
 * additionally proven identity is required. When the verification stack is unconfigured no account is
 * ever identity-verified, so this cleanly blocks payouts until the operator turns the stack on — the
 * deliberate, safe default rather than paying out on an unverified account.
 */
export const requireVerifiedAdult: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!request.userId) throw new UnauthorizedError();
  const user = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { isMinor: true, ageRecordedAt: true, identityVerifiedAt: true },
  });
  if (!user || user.ageRecordedAt === null) throw new BlockedError("AGE_MISSING");
  if (user.isMinor) throw new BlockedError("AGE_UNDER_MINIMUM");
  if (user.identityVerifiedAt === null) throw new BlockedError("IDENTITY_UNVERIFIED");
};
