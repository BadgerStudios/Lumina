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
