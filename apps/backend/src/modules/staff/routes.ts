import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { getIO } from "../../realtime/io.js";
import { requireAuth, requireStaff } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { parseCursor, parseLimit } from "../../lib/pagination.js";
import { serializeVideoWithStatus, VIDEO_AUTHOR_SELECT, VIDEO_TAGS_INCLUDE, VIDEO_SOURCE_INCLUDE } from "../videos/serialize.js";
import { VIDEO_DIRS, unlinkOrThrow } from "../videos/storage.js";
import path from "node:path";

const reviewableStatuses = ["PENDING_REVIEW", "APPROVED", "REJECTED", "REMOVED", "FAILED"] as const;

const listQuerySchema = z.object({
  status: z.enum(reviewableStatuses).default("PENDING_REVIEW"),
  before: z.string().optional(),
  limit: z.string().optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1).max(300) });
const removeSchema = z.object({ reason: z.string().min(1).max(300) });

/**
 * Platform staff routes. Mounted under /api/staff.
 *
 * EVERY route here carries requireStaff — not just the mutating ones. The pending queue is
 * itself sensitive: it contains unreviewed user uploads that no one else is allowed to see, so
 * listing it is as privileged as acting on it. The frontend also hides these surfaces, but that is
 * presentation only; this is the actual boundary.
 */
export default async function staffRoutes(fastify: FastifyInstance) {
  fastify.get("/videos", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new BadRequestError("Invalid query");
    const { status, before, limit: rawLimit } = parsed.data;
    const cursor = parseCursor(before);
    const limit = parseLimit(rawLimit);

    const videos = await prisma.video.findMany({
      where: { status, ...(cursor !== undefined ? { id: { lt: cursor } } : {}) },
      // Oldest-first for the pending queue (fairness — the longest-waiting upload is reviewed
      // first), newest-first for every retrospective tab.
      orderBy: { id: status === "PENDING_REVIEW" ? "asc" : "desc" },
      take: limit,
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });
    return videos.map((v) => serializeVideoWithStatus(v));
  });

  /** Counts for the queue tabs, so staff can see there's work waiting without loading each tab. */
  fastify.get("/videos/counts", { preHandler: [requireAuth, requireStaff] }, async () => {
    const grouped = await prisma.video.groupBy({ by: ["status"], _count: { _all: true } });
    const counts: Record<string, number> = {};
    for (const row of grouped) counts[row.status] = row._count._all;
    return counts;
  });

  fastify.post("/videos/:id/approve", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const video = await loadVideo((request.params as { id: string }).id);
    // Only something awaiting review, or previously taken down, can be published — approving a
    // PROCESSING video would publish a row with no playable file behind it.
    if (video.status !== "PENDING_REVIEW" && video.status !== "REMOVED") {
      throw new BadRequestError(`Cannot approve a video that is ${video.status}`);
    }
    return decide(request.userId!, video.id, "APPROVED", null, "VIDEO_APPROVE");
  });

  fastify.post("/videos/:id/reject", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const parsed = rejectSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A rejection reason is required");
    const video = await loadVideo((request.params as { id: string }).id);
    if (video.status !== "PENDING_REVIEW") {
      throw new BadRequestError(`Cannot reject a video that is ${video.status}`);
    }
    return decide(request.userId!, video.id, "REJECTED", parsed.data.reason, "VIDEO_REJECT");
  });

  /** Takedown of an already-published video. Distinct from reject so the audit trail can
   * distinguish "never published" from "published, then pulled". */
  fastify.post("/videos/:id/remove", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const parsed = removeSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A removal reason is required");
    const video = await loadVideo((request.params as { id: string }).id);
    if (video.status !== "APPROVED") {
      throw new BadRequestError(`Cannot remove a video that is ${video.status}`);
    }
    return decide(request.userId!, video.id, "REMOVED", parsed.data.reason, "VIDEO_REMOVE");
  });

  /**
   * Permanently deletes the media files of a video that is already rejected or removed, while
   * keeping the row and its audit trail. Separated from reject/remove on purpose: a takedown should
   * be reversible for a short window in case of a mistake, and the record of it must outlive the
   * bytes regardless.
   */
  fastify.post("/videos/:id/purge-media", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const video = await loadVideo((request.params as { id: string }).id);
    if (video.status !== "REJECTED" && video.status !== "REMOVED") {
      throw new BadRequestError("Only rejected or removed videos can have their media purged");
    }
    // unlinkOrThrow, not safeUnlink: this route's whole contract is "these bytes are now really
    // gone." safeUnlink previously swallowed a real failure (permissions, a disk error) exactly
    // like it swallows a normal "already gone" — so a failed delete still nulled the DB keys and
    // reported success below, with nothing on disk actually removed. Letting the error propagate
    // here means the route genuinely 500s instead of lying, and none of the DB state below changes
    // unless every file was actually unlinked.
    await Promise.all([
      video.sourceKey ? unlinkOrThrow(path.join(VIDEO_DIRS.source(), video.sourceKey)) : null,
      video.playbackKey ? unlinkOrThrow(path.join(VIDEO_DIRS.playback(), video.playbackKey)) : null,
      video.thumbnailKey ? unlinkOrThrow(path.join(VIDEO_DIRS.thumbs(), video.thumbnailKey)) : null,
    ]);
    const updated = await prisma.video.update({
      where: { id: video.id },
      data: { playbackKey: null, thumbnailKey: null },
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });
    await writeAudit(request.userId!, "VIDEO_PURGE_MEDIA", video.id.toString(), null);
    return serializeVideoWithStatus(updated);
  });

  fastify.get("/audit", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { limit?: string };
    const entries = await prisma.staffAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: parseLimit(query.limit),
      include: { actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    return entries.map((e) => ({
      id: e.id,
      actionType: e.actionType,
      targetType: e.targetType,
      targetId: e.targetId,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      actor: e.actor,
    }));
  });
}

async function loadVideo(rawId: string) {
  let id: bigint;
  try {
    id = BigInt(rawId);
  } catch {
    throw new NotFoundError("Video not found");
  }
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) throw new NotFoundError("Video not found");
  return video;
}

/**
 * Applies a moderation decision, records it, and tells the uploader.
 *
 * The status change and the audit row are written in one transaction: a takedown that isn't logged
 * (or a log entry for a takedown that didn't apply) is worse than either failing outright.
 */
async function decide(
  actorId: string,
  videoId: bigint,
  status: "APPROVED" | "REJECTED" | "REMOVED",
  reason: string | null,
  actionType: string,
) {
  const [updated] = await prisma.$transaction([
    prisma.video.update({
      where: { id: videoId },
      data: {
        status,
        reviewedById: actorId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    }),
    prisma.staffAuditLog.create({
      data: { actorId, actionType, targetType: "video", targetId: videoId.toString(), reason },
    }),
  ]);

  // A stitch or duet physically contains footage from the video just judged. Taking down an
  // original while its derivatives keep playing that same footage in the public feed would defeat
  // the takedown entirely.
  //
  // They are pushed back into the review queue rather than removed outright: a duet is half the
  // deriving creator's own work, and "the original was pulled" is not by itself a finding about
  // the derivative. This puts it in front of a human instead of guessing in either direction.
  if (status === "REMOVED" || status === "REJECTED") {
    const requeued = await prisma.video.updateMany({
      where: { sourceVideoId: videoId, status: "APPROVED" },
      data: {
        status: "PENDING_REVIEW",
        rejectionReason: "Returned for review: the video this was made from was taken down",
      },
    });
    if (requeued.count > 0) {
      await prisma.staffAuditLog.create({
        data: {
          actorId,
          actionType: "video.requeue_derivatives",
          targetType: "video",
          targetId: videoId.toString(),
          reason: `${requeued.count} derivative(s) returned to the review queue`,
        },
      });
    }
  }

  // Approving — including a re-approval after the 5-distinct-report auto-unpublish threshold
  // pulled a video back into review — or removing a video answers every report still open against
  // it. Previously nothing ever closed those reports, so the open count never went back to zero: a
  // video that had ever tripped the threshold once stayed one report away from re-tripping it
  // forever, even right after staff cleared it. Closing them here is what actually resets the
  // counter the /report route reads.
  if (status === "APPROVED" || status === "REMOVED") {
    const outcome = status === "APPROVED" ? "DISMISSED" : "COMPLETED";
    const note = status === "APPROVED" ? "Video was reviewed and approved by staff." : "Video was taken down by staff.";
    const resolved = await prisma.videoReport.updateMany({
      where: { videoId, status: "OPEN" },
      data: { status: outcome, resolutionNote: note, resolvedById: actorId, resolvedAt: new Date() },
    });
    if (resolved.count > 0) {
      await prisma.staffAuditLog.create({
        data: {
          actorId,
          actionType: "video.resolve_reports",
          targetType: "video",
          targetId: videoId.toString(),
          reason: `${resolved.count} open report(s) marked ${outcome.toLowerCase()}`,
        },
      });
    }
  }

  const dto = serializeVideoWithStatus(updated);
  if (updated.authorId) {
    // `user:${id}` rooms are joined automatically at connect, so this reaches the uploader on any
    // device without depending on what channel or feed they happen to be looking at.
    getIO().to(`user:${updated.authorId}`).emit(ServerEvents.VIDEO_STATUS_UPDATE, dto);
  }
  return dto;
}

async function writeAudit(actorId: string, actionType: string, targetId: string, reason: string | null) {
  await prisma.staffAuditLog.create({
    data: { actorId, actionType, targetType: "video", targetId, reason },
  });
}
