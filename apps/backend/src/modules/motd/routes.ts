import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireExecutive } from "../../plugins/authenticate.js";
import { getMotdForUser, listRecentMotds, markMotdSeen, publishMotd, retireMotd } from "./service.js";

/**
 * Message of the day. Mounted under /api/motd.
 *
 * The read side is open to any signed-in member and is deliberately cheap, because it runs on every
 * app load and answers "nothing to show" almost every time. The write side is owner-only: this is a
 * notice that appears unprompted in front of everyone on the platform, which is not authority that
 * should sit anywhere below the top.
 */

const publishSchema = z.object({
  title: z.string().trim().max(80).nullish(),
  // Long enough for a real notice, short enough that it stays a notice rather than becoming a page
  // nobody reads. The composer counts against the same number.
  body: z.string().trim().min(1).max(1000),
});

const seenSchema = z.object({ motdId: z.string().min(1) });

export default async function motdRoutes(fastify: FastifyInstance) {
  /** The notice to show this member right now, or null. */
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    const motd = await getMotdForUser(request.userId!);
    return { motd };
  });

  /** Dismissed. Takes the id that was actually shown — see the service for why. */
  fastify.post("/seen", { schema: { body: seenSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof seenSchema>;
    await markMotdSeen(request.userId!, body.motdId);
    return { ok: true };
  });

  /** What has been published recently, newest first. */
  fastify.get("/all", { preHandler: [requireAuth, requireExecutive] }, async () => {
    return { motds: await listRecentMotds() };
  });

  fastify.post("/", { schema: { body: publishSchema }, preHandler: [requireAuth, requireExecutive] }, async (request) => {
    const body = request.body as z.infer<typeof publishSchema>;
    const motd = await publishMotd({
      title: body.title?.trim() || null,
      body: body.body,
      authorId: request.userId!,
    });
    return { motd };
  });

  /** Take the current notice down without replacing it. */
  fastify.delete("/", { preHandler: [requireAuth, requireExecutive] }, async () => {
    await retireMotd();
    return { ok: true };
  });
}
