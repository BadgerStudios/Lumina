import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import {
  getNote,
  listSaved,
  saveMessage,
  setNote,
  touchStreak,
  unsaveMessage,
} from "./service.js";

const saveSchema = z.object({
  messageId: z.string().min(1),
  note: z.string().max(500).optional(),
  /** ISO timestamp. Absent means saved with no reminder. */
  remindAt: z.string().datetime().optional(),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const noteSchema = z.object({ body: z.string().max(1000) });

/**
 * Things a person keeps, mounted under /api/keep.
 *
 * Every route is scoped to the caller and nothing here is readable by anyone else — a saved message
 * is private, and a note about somebody is emphatically not something its subject can read.
 */
export default async function keepRoutes(fastify: FastifyInstance) {
  fastify.get("/saved", { preHandler: [requireAuth] }, async (request) => {
    const q = listSchema.parse(request.query ?? {});
    return listSaved(request.userId!, q.limit, q.cursor);
  });

  fastify.post("/saved", { schema: { body: saveSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof saveSchema>;
    let messageId: bigint;
    try {
      messageId = BigInt(body.messageId);
    } catch {
      return { ok: false };
    }
    await saveMessage({
      userId: request.userId!,
      messageId,
      note: body.note ?? null,
      remindAt: body.remindAt ? new Date(body.remindAt) : null,
    });
    return { ok: true };
  });

  fastify.delete("/saved/:messageId", { preHandler: [requireAuth] }, async (request) => {
    const { messageId } = request.params as { messageId: string };
    try {
      await unsaveMessage(request.userId!, BigInt(messageId));
    } catch {
      // A malformed id is already "not saved" as far as the caller is concerned.
    }
    return { ok: true };
  });

  fastify.get("/notes/:userId", { preHandler: [requireAuth] }, async (request) => {
    const { userId } = request.params as { userId: string };
    return { note: await getNote(request.userId!, userId) };
  });

  fastify.patch(
    "/notes/:userId",
    { schema: { body: noteSchema }, preHandler: [requireAuth] },
    async (request) => {
      const { userId } = request.params as { userId: string };
      const body = request.body as z.infer<typeof noteSchema>;
      return { note: await setNote(request.userId!, userId, body.body) };
    },
  );

  /**
   * Record today's visit and return the streak.
   *
   * A POST rather than a GET because it writes, and called by the client on session start rather
   * than by a middleware on every request — a streak is "you came back", not "you made an API
   * call", and hooking it into the request path would extend a streak for a background poll from a
   * tab nobody has looked at in a week.
   */
  fastify.post("/streak", { preHandler: [requireAuth] }, async (request) => {
    return touchStreak(request.userId!);
  });
}
