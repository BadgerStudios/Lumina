import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { submitAppeal } from "./service.js";

const appealSchema = z.object({ text: z.string().min(10).max(1000) });

/**
 * Appeal submission. Mounted under /api/bans.
 *
 * Deliberately UNAUTHENTICATED: a banned user cannot authenticate — requireAuth rejects them — so
 * gating the appeal route behind auth would make appeals reachable only by people who don't need
 * them. Authorization instead comes from possessing the ban id, which is returned solely to the
 * banned party in the BannedError body.
 *
 * The ban id is a cuid, so it isn't guessable, and the route is rate-limited: the worst an attacker
 * with a stolen id achieves is filing a bad appeal on someone else's behalf, which a human then
 * reads. That is a far better failure mode than having no appeal path at all, which is not
 * acceptable for a system that matches on IP and device fingerprint and will therefore sometimes
 * catch the wrong person.
 */
export default async function banRoutes(fastify: FastifyInstance) {
  /** Lets the ban screen show why, until when, and whether an appeal is already in flight. */
  fastify.get("/:banId", async (request) => {
    const { banId } = request.params as { banId: string };
    const ban = await prisma.platformBan.findUnique({
      where: { id: banId },
      select: {
        id: true,
        reason: true,
        scope: true,
        expiresAt: true,
        liftedAt: true,
        appealStatus: true,
        appealResponse: true,
        createdAt: true,
      },
    });
    if (!ban) throw new NotFoundError("Not found");
    return {
      id: ban.id,
      reason: ban.reason,
      scope: ban.scope,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
      lifted: Boolean(ban.liftedAt),
      appealStatus: ban.appealStatus,
      appealResponse: ban.appealResponse,
      createdAt: ban.createdAt.toISOString(),
    };
  });

  fastify.post(
    "/:banId/appeal",
    {
      // Unauthenticated and human-reviewed, so the rate limit is the only thing standing between
      // this and an appeal-spam flood filling the owner's queue.
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const { banId } = request.params as { banId: string };
      const parsed = appealSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new BadRequestError("Please explain your appeal in at least 10 characters");
      }

      try {
        await submitAppeal(banId, parsed.data.text);
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }

      reply.code(201);
      return { ok: true };
    },
  );
}
