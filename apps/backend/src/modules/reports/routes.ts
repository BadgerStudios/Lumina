import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { submitContentReport } from "./service.js";
import { prisma } from "../../db/prisma.js";
import { NotFoundError } from "../../lib/errors.js";

const REASONS = [
  "SPAM",
  "HARASSMENT",
  "VIOLENCE",
  "SEXUAL_CONTENT",
  "HATE_SPEECH",
  "SELF_HARM",
  "ILLEGAL",
  "OTHER",
] as const;

/**
 * How urgently a reason needs a human. Lower sorts first.
 *
 * Applied in memory rather than in SQL because it is a judgement about people, not a property of
 * the row — it belongs somewhere a person can read and argue with it, not encoded in an index.
 * The queue is bounded to 200 open reports, so ordering it here costs nothing.
 */
const REASON_URGENCY: Record<string, number> = {
  SELF_HARM: 0,
  ILLEGAL: 1,
  VIOLENCE: 2,
  SEXUAL_CONTENT: 3,
  HATE_SPEECH: 4,
  HARASSMENT: 5,
  SPAM: 6,
  OTHER: 7,
};

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "INVESTIGATING"] as const;

const resolveSchema = z.object({
  status: z.enum(["COMPLETED", "RESOLVED", "DISMISSED"]),
  note: z.string().max(1000).optional(),
});

const bodySchema = z.object({
  targetType: z.enum(["USER", "MESSAGE"]),
  targetId: z.string().min(1),
  reason: z.enum(REASONS),
  details: z.string().max(1000).optional(),
});

/** Mounted under /api/reports — reporting a user or a message (feed videos use /api/videos/:id/report). */
export default async function contentReportRoutes(fastify: FastifyInstance) {
  fastify.post("/", { schema: { body: bodySchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof bodySchema>;
    const result = await submitContentReport({ reporterId: request.userId!, ...body });
    reply.code(201);
    return result;
  });

  /**
   * The queue. Everything below is what was missing: the rows were written and nothing could
   * read them, so a report of harassment or self-harm was invisible to every human on the
   * platform while the badge counted video reports and looked healthy.
   */
  fastify.get("/", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { status?: string };
    const status =
      query.status && ["OPEN", "IN_PROGRESS", "INVESTIGATING", "COMPLETED", "RESOLVED", "DISMISSED"].includes(query.status)
        ? [query.status as (typeof OPEN_STATUSES)[number]]
        : [...OPEN_STATUSES];

    const rows = await prisma.contentReport.findMany({
      where: { status: { in: status } },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    // Most urgent reason first, then oldest — so the longest-waiting self-harm report is the
    // first thing anyone sees, and nothing quietly ages out behind a wall of spam reports.
    rows.sort(
      (a, b) =>
        (REASON_URGENCY[a.reason] ?? 9) - (REASON_URGENCY[b.reason] ?? 9) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );

    return {
      reports: rows.map((r) => ({
        id: r.id,
        reporterId: r.reporterId,
        targetType: r.targetType,
        targetUserId: r.targetUserId,
        targetMessageId: r.targetMessageId === null ? null : String(r.targetMessageId),
        reason: r.reason,
        details: r.details,
        status: r.status,
        assignedToId: r.assignedToId,
        createdAt: r.createdAt.toISOString(),
      })),
      openCount: rows.length,
    };
  });

  fastify.post("/:id/claim", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const report = await prisma.contentReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundError("Report not found");
    const updated = await prisma.contentReport.update({
      where: { id },
      data: { assignedToId: request.userId!, status: "IN_PROGRESS" },
    });
    return { id: updated.id, status: updated.status, assignedToId: updated.assignedToId };
  });

  fastify.post(
    "/:id/resolve",
    { schema: { body: resolveSchema }, preHandler: [requireAuth, requireStaff] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof resolveSchema>;
      const report = await prisma.contentReport.findUnique({ where: { id } });
      if (!report) throw new NotFoundError("Report not found");
      const updated = await prisma.contentReport.update({
        where: { id },
        data: {
          status: body.status,
          resolutionNote: body.note ?? null,
          resolvedById: request.userId!,
          resolvedAt: new Date(),
        },
      });
      return { id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt?.toISOString() ?? null };
    },
  );
}
