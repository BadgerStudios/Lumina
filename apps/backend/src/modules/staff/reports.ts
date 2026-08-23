import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { getIO } from "../../realtime/io.js";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { VIDEO_AUTHOR_SELECT } from "../videos/serialize.js";

const claimSchema = z.object({
  status: z.enum(["IN_PROGRESS", "INVESTIGATING"]).default("IN_PROGRESS"),
});
const rateSchema = z.object({ rating: z.number().int().min(1).max(5) });
const completeSchema = z.object({
  outcome: z.enum(["COMPLETED", "DISMISSED"]),
  note: z.string().min(1).max(1000),
});

/**
 * Report tickets. Mounted under /api/staff/reports.
 *
 * A report is treated as a ticket with an owner and a lifecycle rather than a row that silently
 * flips to "resolved": OPEN → IN_PROGRESS/INVESTIGATING → COMPLETED or DISMISSED. Two things follow
 * from that and are the reason for the extra state — a ticket in progress has a named person on it,
 * so two moderators don't unknowingly work the same report, and a finished ticket sends its outcome
 * back to whoever filed it, because a report that vanishes into a queue teaches people to stop
 * reporting.
 */
export default async function reportRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const take = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50));

    const reports = await prisma.videoReport.findMany({
      where: query.status ? { status: query.status as never } : {},
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      take,
      include: {
        reporter: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        assignedTo: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        resolvedBy: { select: { id: true, username: true, displayName: true } },
        video: {
          select: {
            id: true,
            caption: true,
            status: true,
            thumbnailKey: true,
            playbackKey: true,
            author: { select: VIDEO_AUTHOR_SELECT },
          },
        },
      },
    });

    // How many other people reported the same video — the single most useful number on the card,
    // since one report and nine reports warrant very different urgency.
    const videoIds = reports.map((r) => r.videoId);
    const grouped = videoIds.length
      ? await prisma.videoReport.groupBy({
          by: ["videoId"],
          where: { videoId: { in: videoIds } },
          _count: { _all: true },
        })
      : [];
    const countByVideo = new Map(grouped.map((g) => [g.videoId.toString(), g._count._all]));

    const counts = await prisma.videoReport.groupBy({ by: ["status"], _count: { _all: true } });

    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      reports: reports.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        details: r.details,
        createdAt: r.createdAt.toISOString(),
        assignedAt: r.assignedAt?.toISOString() ?? null,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolutionNote: r.resolutionNote,
        reporter: r.reporter,
        assignedTo: r.assignedTo,
        resolvedBy: r.resolvedBy,
        totalReportsOnVideo: countByVideo.get(r.videoId.toString()) ?? 1,
        video: {
          id: r.video.id.toString(),
          caption: r.video.caption,
          status: r.video.status,
          thumbnailUrl: r.video.thumbnailKey ? `/api/videos/${r.video.id}/thumbnail` : null,
          playbackUrl: r.video.playbackKey ? `/api/videos/${r.video.id}/playback` : null,
          author: r.video.author,
        },
      })),
    };
  });

  /** Claims a ticket. */
  fastify.post("/:id/claim", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = claimSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid status");

    const report = await prisma.videoReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundError("Report not found");
    if (report.status === "COMPLETED" || report.status === "DISMISSED") {
      throw new BadRequestError("This ticket is already closed");
    }
    // Claiming something another moderator is already working is the exact collision this field
    // exists to prevent, so it is refused rather than silently reassigned.
    if (report.assignedToId && report.assignedToId !== request.userId) {
      throw new ForbiddenError("Another moderator is already working this ticket");
    }

    // Conditional claim, not a plain update: the assignee check above is a read-time snapshot, so
    // two moderators claiming the same UNASSIGNED ticket at once would both pass it and both write,
    // the second silently stealing the assignment. Only claim a ticket that is still unassigned (or
    // already ours) and not closed; count===0 means someone else won the race.
    const claimed = await prisma.videoReport.updateMany({
      where: {
        id,
        OR: [{ assignedToId: null }, { assignedToId: request.userId! }],
        status: { notIn: ["COMPLETED", "DISMISSED"] },
      },
      data: {
        status: parsed.data.status,
        assignedToId: request.userId!,
        assignedAt: report.assignedAt ?? new Date(),
      },
    });
    if (claimed.count === 0) throw new ForbiddenError("Another moderator is already working this ticket");

    const updated = await prisma.videoReport.findUniqueOrThrow({
      where: { id },
      include: { assignedTo: { select: { id: true, username: true, displayName: true } } },
    });

    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "REPORT_CLAIM",
        targetType: "report",
        targetId: id,
        reason: parsed.data.status,
      },
    });

    return { id: updated.id, status: updated.status, assignedTo: updated.assignedTo };
  });

  /** Releases a claim without closing the ticket. */
  fastify.post("/:id/release", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const report = await prisma.videoReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundError("Report not found");
    // Without this, releasing a ticket the same moderator had already completed (still "assigned"
    // to them per the /complete route's own comment) silently reopened it — flipping status back to
    // OPEN and clearing assignedToId/assignedAt while the resolution note, resolvedBy and resolvedAt
    // stayed behind, un-resolving a closed ticket with no trace of why.
    if (report.status === "COMPLETED" || report.status === "DISMISSED") {
      throw new BadRequestError("This ticket is already closed");
    }
    if (report.assignedToId !== request.userId) {
      throw new ForbiddenError("This ticket isn't assigned to you");
    }
    await prisma.videoReport.update({
      where: { id },
      data: { status: "OPEN", assignedToId: null, assignedAt: null },
    });
    return { ok: true };
  });

  /**
   * Closes a ticket and tells the reporter what happened.
   *
   * The note is required: closing with no explanation is what makes a report system feel like a
   * void, and it is the only thing the person who took the trouble to report actually receives.
   */
  fastify.post("/:id/complete", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = completeSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("An outcome and a note are required");

    const report = await prisma.videoReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundError("Report not found");
    if (report.status === "COMPLETED" || report.status === "DISMISSED") {
      throw new BadRequestError("This ticket is already closed");
    }

    const updated = await prisma.videoReport.update({
      where: { id },
      data: {
        status: parsed.data.outcome,
        resolutionNote: parsed.data.note,
        resolvedById: request.userId!,
        resolvedAt: new Date(),
        // Completing without claiming first is allowed — the ticket still records who did it.
        assignedToId: report.assignedToId ?? request.userId!,
      },
      include: {
        resolvedBy: { select: { id: true, username: true, displayName: true } },
      },
    });

    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: parsed.data.outcome === "COMPLETED" ? "REPORT_COMPLETE" : "REPORT_DISMISS",
        targetType: "report",
        targetId: id,
        reason: parsed.data.note.slice(0, 300),
      },
    });

    // Back to the person who filed it, on their own `user:` room — joined automatically at connect,
    // so this reaches them on whatever device they're using without any extra plumbing.
    if (report.reporterId) {
      getIO().to(`user:${report.reporterId}`).emit(ServerEvents.REPORT_RESOLVED, {
        reportId: updated.id,
        videoId: report.videoId.toString(),
        outcome: parsed.data.outcome,
        note: parsed.data.note,
        resolvedAt: updated.resolvedAt?.toISOString() ?? new Date().toISOString(),
      });
    }

    return { id: updated.id, status: updated.status, resolvedBy: updated.resolvedBy };
  });

  /**
   * The reporter rates how their report was handled, 1-5 stars. Each star is a point to the staff
   * member who resolved it.
   *
   * Reporter-only, own-ticket-only, and only once a ticket is closed — rating something still being
   * worked would score a job that isn't finished. One-shot: a rating cannot be changed, or it
   * becomes a lever to pressure a moderator into revisiting a decision.
   */
  fastify.post("/:id/rate", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = rateSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A rating between 1 and 5 is required");

    const report = await prisma.videoReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundError("Report not found");
    if (report.reporterId !== request.userId) {
      throw new ForbiddenError("You can only rate your own reports");
    }
    if (report.status !== "COMPLETED" && report.status !== "DISMISSED") {
      throw new BadRequestError("You can rate this once it's been resolved");
    }
    if (report.rating !== null) throw new BadRequestError("You've already rated this report");

    await prisma.videoReport.update({
      where: { id },
      data: { rating: parsed.data.rating, ratedAt: new Date() },
    });
    return { ok: true, rating: parsed.data.rating };
  });

  /**
   * Staff leaderboard.
   *
   * Reports BOTH volume and average rating, never rating alone. Rating on its own is a misleading
   * ranking here: a moderator who correctly dismisses a bogus report is being scored by the person
   * whose report was dismissed, so accurate refusals systematically rate lower than agreeable ones.
   * Showing resolved-count, dismissal rate and rating side by side makes that visible instead of
   * quietly rewarding whoever tells reporters what they want to hear.
   */
  fastify.get("/leaderboard", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { days?: string };
    const days = Math.min(365, Math.max(1, Number(query.days ?? 30) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const resolved = await prisma.videoReport.findMany({
      where: { resolvedById: { not: null }, resolvedAt: { gte: since } },
      select: {
        resolvedById: true,
        rating: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        resolvedBy: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    const byStaff = new Map<string, {
      user: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
      resolved: number;
      dismissed: number;
      points: number;
      ratingSum: number;
      ratingCount: number;
      totalHandlingMs: number;
    }>();

    for (const r of resolved) {
      if (!r.resolvedById || !r.resolvedBy) continue;
      const entry = byStaff.get(r.resolvedById) ?? {
        user: r.resolvedBy,
        resolved: 0,
        dismissed: 0,
        points: 0,
        ratingSum: 0,
        ratingCount: 0,
        totalHandlingMs: 0,
      };
      entry.resolved += 1;
      if (r.status === "DISMISSED") entry.dismissed += 1;
      if (r.rating !== null) {
        // Stars are the points. Unrated tickets contribute nothing rather than zero — see the
        // schema comment on why silence must not read as a bad score.
        entry.points += r.rating;
        entry.ratingSum += r.rating;
        entry.ratingCount += 1;
      }
      if (r.resolvedAt) entry.totalHandlingMs += r.resolvedAt.getTime() - r.createdAt.getTime();
      byStaff.set(r.resolvedById, entry);
    }

    const board = Array.from(byStaff.values())
      .map((e) => ({
        user: e.user,
        resolved: e.resolved,
        dismissed: e.dismissed,
        points: e.points,
        averageRating: e.ratingCount > 0 ? Number((e.ratingSum / e.ratingCount).toFixed(2)) : null,
        ratedCount: e.ratingCount,
        // Median would be more robust, but mean over a small set is easier to reason about and this
        // is a nudge, not a performance review.
        averageHandlingHours:
          e.resolved > 0 ? Number((e.totalHandlingMs / e.resolved / 3_600_000).toFixed(1)) : null,
      }))
      // Ranked by points, with volume as the tiebreak — points already fold in both how much
      // someone handled and how it landed.
      .sort((a, b) => b.points - a.points || b.resolved - a.resolved);

    return { days, leaderboard: board };
  });

  /** The reporter's own view of what they've filed and how it ended. */
  fastify.get("/mine", { preHandler: [requireAuth] }, async (request) => {
    const reports = await prisma.videoReport.findMany({
      where: { reporterId: request.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        reason: true,
        createdAt: true,
        resolvedAt: true,
        resolutionNote: true,
        rating: true,
        videoId: true,
      },
    });
    return {
      reports: reports.map((r) => ({
        ...r,
        videoId: r.videoId.toString(),
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        // The moderator's name is deliberately not included — the reporter needs the outcome, not
        // a person to direct any grievance at.
      })),
    };
  });
}
