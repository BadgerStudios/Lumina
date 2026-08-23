import type { FastifyInstance } from "fastify";
import { pushInboxNotification } from "../inbox/service.js";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { isStaff } from "../../lib/platformRole.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { parseCursor, parseLimit } from "../../lib/pagination.js";
import { serializeUser } from "../../lib/serialize.js";
import { VIDEO_AUTHOR_SELECT } from "./serialize.js";
import { extractMentionUsernames } from "../../lib/textTokens.js";
import { invalidateTasteProfile } from "../feed/taste.js";
import { sendPushToUser } from "../../lib/push.js";
import { isBlockedEitherWay } from "../friends/service.js";

// .trim() BEFORE .min(1) — zod applies these in order, so trimming first is what makes a
// whitespace-only comment ("   ") fail. Validating length first would count those spaces as
// content and happily store a blank comment.
const createCommentSchema = z.object({ content: z.string().trim().min(1).max(500) });

const reportSchema = z.object({
  reason: z.enum([
    "SPAM",
    "HARASSMENT",
    "VIOLENCE",
    "SEXUAL_CONTENT",
    "HATE_SPEECH",
    "SELF_HARM",
    "ILLEGAL",
    "OTHER",
  ]),
  details: z.string().max(500).optional(),
});

/**
 * Number of DISTINCT reporters that pulls an already-approved video back into the staff queue.
 *
 * Deliberately not 1. A single report unpublishing a video hands any one user a veto over anything
 * they dislike, which is a far more common abuse than the thing reporting is meant to catch. The
 * unique constraint on (videoId, reporterId) is what makes "distinct" real.
 */
const AUTO_UNPUBLISH_THRESHOLD = 5;

/** Comment + report routes, mounted under /api/videos alongside videos/routes.ts. */
/**
 * Notifies people named with @username in a comment.
 *
 * Three things it deliberately refuses to do: notify you about your own comment, notify anyone a
 * block exists with in either direction (a mention is otherwise a way to push a notification to
 * someone who has blocked you), and notify a bot. Unresolvable names are simply ignored — the text
 * still renders with the @ highlighted, which is a harmless cosmetic false positive rather than
 * something worth erroring over.
 */
async function notifyMentions(content: string, authorId: string, videoId: bigint): Promise<void> {
  try {
    const usernames = extractMentionUsernames(content);
    if (usernames.length === 0) return;

    const users = await prisma.user.findMany({
      where: { username: { in: usernames, mode: "insensitive" }, isBot: false },
      select: { id: true },
    });
    const author = await prisma.user.findUnique({
      where: { id: authorId },
      select: { username: true, displayName: true },
    });
    const name = author?.displayName ?? author?.username ?? "Someone";

    for (const u of users) {
      if (u.id === authorId) continue;
      if (await isBlockedEitherWay(authorId, u.id)) continue;
      void sendPushToUser(u.id, {
        title: `${name} mentioned you`,
        body: content.slice(0, 120),
        url: "/foryou",
        tag: `video-mention-${videoId}`,
      });
    }
  } catch {
    /* a failed notification must never surface as a failed comment */
  }
}

export default async function videoSocialRoutes(fastify: FastifyInstance) {
  fastify.get("/:id/comments", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const videoId = parseVideoId((request.params as { id: string }).id);
    await assertVisible(videoId, request.userId!);

    const query = request.query as { before?: string; limit?: string };
    const cursor = parseCursor(query.before);
    const limit = parseLimit(query.limit);

    const comments = await prisma.videoComment.findMany({
      where: { videoId, ...(cursor !== undefined ? { id: { lt: cursor } } : {}) },
      orderBy: { id: "desc" },
      take: limit,
      include: { author: { select: VIDEO_AUTHOR_SELECT } },
    });

    return comments.map((c) => ({
      id: c.id.toString(),
      videoId: c.videoId.toString(),
      content: c.content,
      createdAt: c.createdAt.toISOString(),
      author: c.author ? serializeUser(c.author) : null,
    }));
  });

  fastify.post(
    "/:id/comments",
    {
      preHandler: [requireAuth, requireAdult],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const videoId = parseVideoId((request.params as { id: string }).id);
      const parsed = createCommentSchema.safeParse(request.body);
      if (!parsed.success) throw new BadRequestError("Comment cannot be empty");
      // Commenting requires the video to be publicly visible — not merely visible to this caller.
      // Otherwise an uploader could accumulate comments on something still awaiting review.
      await assertApproved(videoId);

      // Counter and row in one transaction so commentCount can't drift from reality.
      const [comment] = await prisma.$transaction([
        prisma.videoComment.create({
          data: { videoId, authorId: request.userId!, content: parsed.data.content },
          include: { author: { select: VIDEO_AUTHOR_SELECT } },
        }),
        prisma.video.update({ where: { id: videoId }, data: { commentCount: { increment: 1 } } }),
      ]);

      // The profile is derived from likes and comments, so this comment just changed it.
      void invalidateTasteProfile(request.userId!);

      // Mentions notify, fire-and-forget — a comment must not wait on push delivery, and a push
      // failure must not fail the comment.
      void notifyMentions(comment.content, request.userId!, videoId);
      void (async () => {
        const video = await prisma.video.findUnique({ where: { id: videoId }, select: { authorId: true } });
        // notifyMentions above already refuses to notify across a block; this sibling path — the
        // plain "someone commented" notification, sent for the exact same comment — did not, so a
        // user blocked by the uploader could still land in their inbox by commenting without an
        // @mention while the same comment WITH a mention would have been filtered. Same rule,
        // applied consistently.
        if (video?.authorId && !(await isBlockedEitherWay(video.authorId, request.userId!))) {
          await pushInboxNotification({
            userId: video.authorId,
            kind: "VIDEO_COMMENT",
            bundleKey: `VIDEO_COMMENT:${videoId}`,
            actorId: request.userId!,
            videoId: videoId.toString(),
            preview: parsed.data.content.slice(0, 140),
          });
        }
      })().catch(() => undefined);

      reply.code(201);
      return {
        id: comment.id.toString(),
        videoId: comment.videoId.toString(),
        content: comment.content,
        createdAt: comment.createdAt.toISOString(),
        author: comment.author ? serializeUser(comment.author) : null,
      };
    },
  );

  /** A comment can be deleted by its author or by the video's uploader — the latter so someone is
   * able to moderate their own post's replies without needing platform staff. */
  fastify.delete("/comments/:commentId", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const raw = (request.params as { commentId: string }).commentId;
    let commentId: bigint;
    try {
      commentId = BigInt(raw);
    } catch {
      throw new NotFoundError("Comment not found");
    }

    const comment = await prisma.videoComment.findUnique({
      where: { id: commentId },
      include: { video: { select: { authorId: true } } },
    });
    if (!comment) throw new NotFoundError("Comment not found");

    const viewer = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { platformRole: true },
    });
    const allowed =
      comment.authorId === request.userId ||
      comment.video.authorId === request.userId ||
      isStaff(viewer?.platformRole);
    if (!allowed) throw new ForbiddenError("You cannot delete this comment");

    await prisma.$transaction([
      prisma.videoComment.delete({ where: { id: commentId } }),
      prisma.video.update({
        where: { id: comment.videoId },
        data: { commentCount: { decrement: 1 } },
      }),
    ]);
    return { ok: true };
  });

  fastify.post(
    "/:id/report",
    {
      preHandler: [requireAuth, requireAdult],
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const videoId = parseVideoId((request.params as { id: string }).id);
      const parsed = reportSchema.safeParse(request.body);
      if (!parsed.success) throw new BadRequestError("A valid report reason is required");
      const userId = request.userId!;

      const video = await prisma.video.findUnique({
        where: { id: videoId },
        select: { id: true, status: true },
      });
      if (!video) throw new NotFoundError("Video not found");

      try {
        await prisma.videoReport.create({
          data: {
            videoId,
            reporterId: userId,
            reason: parsed.data.reason,
            details: parsed.data.details ?? null,
          },
        });
      } catch (err) {
        // The unique constraint is the intended mechanism, so a duplicate is a normal outcome
        // rather than an error condition worth logging.
        if ((err as { code?: string }).code === "P2002") {
          throw new ConflictError("You've already reported this video");
        }
        throw err;
      }

      // Distinct-reporter count. Only an APPROVED video can be auto-pulled — something already
      // pending, rejected or removed has nowhere further to go.
      if (video.status === "APPROVED") {
        const distinctReporters = await prisma.videoReport.count({
          where: { videoId, status: "OPEN" },
        });
        if (distinctReporters >= AUTO_UNPUBLISH_THRESHOLD) {
          await prisma.video.update({
            where: { id: videoId },
            data: {
              status: "PENDING_REVIEW",
              rejectionReason: `Automatically unpublished after ${distinctReporters} reports — awaiting re-review`,
            },
          });
        }
      }

      reply.code(201);
      return { ok: true };
    },
  );
}

function parseVideoId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new NotFoundError("Video not found");
  }
}

async function assertApproved(videoId: bigint): Promise<void> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { status: true } });
  if (!video || video.status !== "APPROVED") throw new NotFoundError("Video not found");
}

/** Same visibility rule the metadata and media routes use: public once APPROVED, otherwise
 * uploader-or-staff only, and a 404 rather than a 403 so a guessed id can't confirm that a
 * pending video exists. */
async function assertVisible(videoId: bigint, userId: string): Promise<void> {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { status: true, authorId: true },
  });
  if (!video) throw new NotFoundError("Video not found");
  if (video.status === "APPROVED") return;
  if (video.authorId === userId) return;
  const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
  if (isStaff(viewer?.platformRole)) return;
  throw new NotFoundError("Video not found");
}

export { AUTO_UNPUBLISH_THRESHOLD };
