import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { ForbiddenError } from "../../lib/errors.js";
import {
  claimTicket,
  completeTicket,
  getTicket,
  listTickets,
  openSupportTicket,
  releaseTicket,
  replyToTicket,
  ticketOwnerId,
} from "./service.js";

const listSchema = z.object({
  status: z.enum(["OPEN", "ACTIVE", "CLOSED", "ALL"]).default("ACTIVE"),
  category: z.enum(["USER_REPORT", "SYSTEM_FLAGGED", "CUSTOMER_SUPPORT"]).optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const claimSchema = z.object({ status: z.enum(["IN_PROGRESS", "INVESTIGATING"]).default("IN_PROGRESS") });
const completeSchema = z.object({
  outcome: z.enum(["COMPLETED", "DISMISSED"]),
  note: z.string().min(1).max(1000),
});
const replySchema = z.object({
  body: z.string().min(1).max(4000),
  /** A note to other staff rather than a reply to the reporter. Ignored for non-staff. */
  internal: z.boolean().default(false),
});
const supportSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});

/**
 * Tickets, mounted under /api/tickets.
 *
 * The queue and everything that acts on it is staff-only. The two exceptions are the routes a
 * normal person needs to be part of their own ticket: opening a support request, and reading or
 * replying to one they filed. Those are `requireAuth` and check ownership per ticket — a signed-in
 * account may read its own conversation and nobody else's.
 */
export default async function ticketRoutes(fastify: FastifyInstance) {
  // ── the moderator queue ────────────────────────────────────────────────────
  fastify.get("/", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const q = listSchema.parse(request.query ?? {});
    return listTickets({
      status: q.status,
      category: q.category,
      assignedToId: q.mine ? request.userId! : undefined,
      limit: q.limit,
    });
  });

  fastify.get("/detail/:ref", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { ref } = request.params as { ref: string };
    // Staff see the internal notes; that is what distinguishes this from the /mine read below.
    return getTicket(ref, true);
  });

  fastify.post("/detail/:ref/claim", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { ref } = request.params as { ref: string };
    const { status } = claimSchema.parse(request.body ?? {});
    await claimTicket(ref, request.userId!, status);
    return getTicket(ref, true);
  });

  fastify.post("/detail/:ref/release", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { ref } = request.params as { ref: string };
    await releaseTicket(ref, request.userId!);
    return getTicket(ref, true);
  });

  fastify.post("/detail/:ref/reply", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { ref } = request.params as { ref: string };
    const body = replySchema.parse(request.body ?? {});
    await replyToTicket({
      ref,
      authorId: request.userId!,
      body: body.body,
      fromStaff: true,
      internal: body.internal,
    });
    return getTicket(ref, true);
  });

  fastify.post("/detail/:ref/complete", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { ref } = request.params as { ref: string };
    const body = completeSchema.parse(request.body ?? {});
    await completeTicket(ref, request.userId!, body.outcome, body.note);
    return getTicket(ref, true);
  });

  // ── a person's own ticket ──────────────────────────────────────────────────
  fastify.post("/support", { schema: { body: supportSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof supportSchema>;
    return openSupportTicket({ userId: request.userId!, subject: body.subject, body: body.body });
  });

  fastify.get("/mine", { preHandler: [requireAuth] }, async (request) => {
    const all = await listTickets({ status: "ALL", limit: 100 });
    // Filtered here rather than in the query because "mine" means FILED BY me, while the queue's
    // own `mine` means CLAIMED BY me — two different questions that would otherwise share a name.
    return { tickets: all.tickets.filter((t) => t.person?.id === request.userId!) };
  });

  /** Ownership is checked per ticket: this is the one read a non-staff account gets. */
  fastify.get("/mine/:ref", { preHandler: [requireAuth] }, async (request) => {
    const { ref } = request.params as { ref: string };
    if ((await ticketOwnerId(ref)) !== request.userId!) {
      throw new ForbiddenError("That isn't your ticket");
    }
    return getTicket(ref, false);
  });

  fastify.post("/mine/:ref/reply", { preHandler: [requireAuth] }, async (request) => {
    const { ref } = request.params as { ref: string };
    if ((await ticketOwnerId(ref)) !== request.userId!) {
      throw new ForbiddenError("That isn't your ticket");
    }
    const body = replySchema.parse(request.body ?? {});
    await replyToTicket({
      ref,
      authorId: request.userId!,
      body: body.body,
      fromStaff: false,
      internal: false,
    });
    return getTicket(ref, false);
  });
}
