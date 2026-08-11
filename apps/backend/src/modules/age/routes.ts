import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, BlockedError } from "../../lib/errors.js";
import { serializeMe } from "../../lib/serialize.js";
import { recordFlag } from "../flags/service.js";
import { checkAge } from "./service.js";

const submitSchema = z.object({
  ageBracket: z.enum(["UNDER_18", "AGE_18_24", "AGE_25_34", "AGE_35_49", "AGE_50_PLUS"]),
  birthDate: z.string().min(1),
});

/** Mounted under /api/age */
export default async function ageRoutes(fastify: FastifyInstance) {
  /**
   * Records age for an account that never had it — the 390-odd accounts created before age
   * collection existed.
   *
   * Deliberately does NOT delete an under-18 account. Deleting someone's account and everything in
   * it from a single modal tap is unrecoverable if they mis-tapped, and an existing account is a
   * different situation from a new signup: the person is already here. Under-18 answers restrict the
   * account (no feed, no cross-age contact) and raise a flag for a human, which is reversible in a
   * way that deletion is not.
   *
   * Write-once: an account cannot re-answer to change its own age, which would make the whole thing
   * an opt-in switch. Corrections go through support.
   */
  fastify.post("/", { preHandler: [requireAuth] }, async (request) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("Please choose an age range and enter your date of birth");

    const user = await prisma.user.findUnique({ where: { id: request.userId! } });
    if (!user) throw new BadRequestError("Account not found");
    if (user.ageRecordedAt) throw new BadRequestError("Your age is already on record");

    const birthDate = new Date(parsed.data.birthDate);
    if (Number.isNaN(birthDate.getTime())) throw new BadRequestError("That date of birth isn't valid");
    const years = (Date.now() - birthDate.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (years < 0 || years > 120) throw new BadRequestError("That date of birth isn't valid");

    const result = checkAge(parsed.data.ageBracket, birthDate);

    if (!result.ok) {
      // Recorded either way — the answer is what it is, and leaving it null would just re-prompt
      // forever while the account stayed in the same restricted state anyway.
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          ageBracket: result.bracket,
          birthDate,
          isMinor: true,
          ageRecordedAt: new Date(),
        },
      });
      await recordFlag({
        userId: user.id,
        reasonCode: result.reasonCode,
        detail: `existing account answered ${parsed.data.ageBracket}`,
      });
      throw new BlockedError(result.reasonCode);
      // Unreachable, but keeps the updated row referenced for clarity about what was written.
      return serializeMe(updated);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ageBracket: result.bracket,
        birthDate,
        isMinor: result.isMinor,
        ageRecordedAt: new Date(),
      },
    });
    return serializeMe(updated);
  });
}
