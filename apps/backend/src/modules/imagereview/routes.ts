import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireStaff, requireAdmin } from "../../plugins/authenticate.js";
import { approveImage, listImages, removeImage, type ImageFilter } from "./images.js";

const listSchema = z.object({
  filter: z.enum(["pending", "reported", "removed", "all"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  cursor: z.string().optional(),
});

const removeSchema = z.object({
  reason: z.string().min(1).max(500),
  /**
   * Present only when the reviewer chose to act on the person as well as the image. Absent means
   * the image comes down and nothing happens to them, which is the right default for a first
   * mistake — so this is opt-in rather than a set of booleans that default to false.
   */
  ban: z
    .object({
      email: z.boolean().default(false),
      ip: z.boolean().default(false),
      device: z.boolean().default(false),
      reason: z.string().max(300).optional(),
      /** Null or absent is permanent. */
      days: z.number().int().min(1).max(3650).nullable().optional(),
    })
    .optional(),
});

/**
 * Image review, mounted under /api/owner/images.
 *
 * Reading and clearing sit at the staff floor — working a moderation queue is what a moderator is
 * for. Removing is gated one rung higher, at ADMIN, because it can carry a ban: that is the same
 * gate the ban routes themselves carry, and it would be strange for this screen to be the way
 * around it.
 */
export default async function imageReviewRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const parsed = listSchema.parse(request.query ?? {});
    return listImages({
      filter: parsed.filter as ImageFilter,
      limit: parsed.limit,
      cursor: parsed.cursor,
    });
  });

  fastify.post("/:id/approve", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    await approveImage((request.params as { id: string }).id, request.userId!);
    return { ok: true };
  });

  fastify.post(
    "/:id/remove",
    { schema: { body: removeSchema }, preHandler: [requireAuth, requireAdmin] },
    async (request) => {
      const body = request.body as z.infer<typeof removeSchema>;
      return removeImage({
        id: (request.params as { id: string }).id,
        actorId: request.userId!,
        reason: body.reason,
        ban: body.ban,
      });
    },
  );
}
