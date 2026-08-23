import type { FastifyInstance } from "fastify";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { isStaff } from "../../lib/platformRole.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { requireTurnstileForRisky } from "../../plugins/turnstile.js";
import { assertTrustedOrigin } from "../risk/service.js";
import { extractMediaUserId } from "../../lib/mediaAuth.js";
import { sendFileWithRange } from "../../lib/sendFile.js";
import { BadRequestError, NotFoundError, TooManyRequestsError } from "../../lib/errors.js";
import { parseCursor, parseLimit } from "../../lib/pagination.js";
import { VIDEO_DIRS, statSize, streamUploadToDisk, UploadTooLargeError } from "./storage.js";
import { serializeVideo, serializeVideoWithStatus, VIDEO_AUTHOR_SELECT, VIDEO_TAGS_INCLUDE, VIDEO_SOURCE_INCLUDE } from "./serialize.js";
import { recordBandwidth } from "../metrics/service.js";
import { enqueueTranscode } from "./queue.js";
import { resolveTags, attachTags, MAX_TAGS_PER_VIDEO } from "../tags/service.js";
import { extractHashtags } from "../../lib/textTokens.js";
import { readDeviceFingerprint } from "../auth/service.js";
import { MAX_STITCH_MS, MIN_STITCH_MS } from "./remix.js";
import { parseBigIntId } from "../../lib/parseBigIntId.js";

/** Container formats a browser can plausibly produce from a file picker or MediaRecorder. The
 * worker re-probes and re-encodes regardless, so this is a cheap early reject to avoid spending
 * disk and a transcode slot on something obviously not a video — not a security boundary (a
 * client-supplied mimetype is trivially forged; ffprobe in the worker is what actually decides). */
const ACCEPTED_VIDEO_MIME = /^video\/(mp4|quicktime|webm|x-matroska|x-m4v|mpeg|3gpp)$/;

/** Mounted under /api/videos */
export default async function videoRoutes(fastify: FastifyInstance) {
  /**
   * Upload. Streams straight to disk (see storage.ts) rather than buffering, and raises the file
   * size limit for THIS route only — the plugin-level multipart limit stays at MAX_UPLOAD_MB (25)
   * for chat attachments, and is overridden per-request here via `request.file({ limits })`.
   */
  fastify.post(
    "/",
    {
      preHandler: [requireAuth, requireAdult, requireTurnstileForRisky],
      // Uploads are the most expensive request this server accepts (disk + a transcode slot), so
      // they get a far tighter budget than the app-wide 300/min default in plugins/rateLimit.ts.
      // This is the abuse brake; the per-day quota below is the fairness one.
      config: { rateLimit: { max: 12, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      if (!request.isMultipart()) throw new BadRequestError("Expected a multipart upload");

      // Before the quota and before a single byte is written: an upload refused after the transfer
      // has already cost the disk and the user's bandwidth is a worse refusal than one refused up
      // front.
      await assertTrustedOrigin(request, userId, "video upload");

      await assertDailyQuota(userId);

      const part = await request.file({
        limits: { fileSize: env.MAX_VIDEO_UPLOAD_MB * 1024 * 1024, files: 1 },
      });
      if (!part) throw new BadRequestError("No file provided");
      if (!ACCEPTED_VIDEO_MIME.test(part.mimetype)) {
        throw new BadRequestError(`Unsupported video type: ${part.mimetype}`);
      }

      // `part.fields` carries the non-file form fields parsed so far. Reading the caption here
      // (rather than iterating request.parts()) keeps the single-file streaming path intact.
      const tagsField = part.fields?.tags;
      const rawTags =
        tagsField && !Array.isArray(tagsField) && tagsField.type === "field"
          ? String(tagsField.value ?? "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];

      const field = (name: string): string => {
        const f = part.fields?.[name];
        return f && !Array.isArray(f) && f.type === "field" ? String(f.value ?? "") : "";
      };

      const rawCaption = field("caption");
      const caption = rawCaption.trim().slice(0, 300) || null;

      // Remix parameters, resolved BEFORE a single byte is written to disk. Rejecting a duet of a
      // video whose author disabled duets after a 90MB upload has already landed would burn the
      // disk and the uploader's daily quota to reach the same answer.
      const remix = await resolveRemix(userId, {
        stitchOf: field("stitchOf"),
        duetOf: field("duetOf"),
        stitchStartMs: field("stitchStartMs"),
        stitchEndMs: field("stitchEndMs"),
      });

      const allowStitch = field("allowStitch") !== "false";
      const allowDuet = field("allowDuet") !== "false";

      const sourceKey = randomUUID();
      let uploaded: { sizeBytes: number; sha256: string };
      try {
        uploaded = await streamUploadToDisk(part, sourceKey);
      } catch (err) {
        if (err instanceof UploadTooLargeError) throw new BadRequestError(err.message);
        throw err;
      }
      if (uploaded.sizeBytes === 0) throw new BadRequestError("Uploaded file is empty");

      const video = await prisma.video.create({
        data: {
          authorId: userId,
          caption,
          sourceKey,
          mimeType: part.mimetype,
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256,
          status: "PROCESSING",
          allowStitch,
          allowDuet,
          ...(remix
            ? {
                sourceVideoId: remix.sourceId,
                derivativeType: remix.type,
                sourceStartMs: remix.startMs,
                sourceEndMs: remix.endMs,
              }
            : {}),
          // Upload provenance — recorded so an unlawful upload can be attributed on a lawful
          // request. Master-only on read; see the Video model for why this is stored in the clear
          // where bans and flags store hashes.
          uploadIp: request.ip ?? null,
          uploadDevice: readDeviceFingerprint(request),
          uploadUserAgent: (request.headers["user-agent"] ?? "").slice(0, 300) || null,
        },
        include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
      });

      // Tags can only be attached once the row exists, so the `create` above cannot have returned
      // them. Folding them back in keeps the 201 honest — otherwise the uploader's own client is
      // told its video has no tags a moment after it supplied some.
      // Hashtags typed into the caption become real tags, not just styled text. Someone writing
      // "#reef" in the caption plainly means it as a tag, and requiring them to also type it into
      // the tag picker makes the picker feel like a form to satisfy rather than a feature. Explicit
      // picker tags come first so they win the cap when a caption is hashtag-heavy.
      const captionTags = extractHashtags(caption);
      const merged = [...rawTags, ...captionTags].slice(0, MAX_TAGS_PER_VIDEO);
      if (merged.length > 0) {
        const tags = await resolveTags(merged, userId);
        await attachTags(video.id, tags.map((t) => t.id));
        video.tags = tags.map((t) => ({ tag: { name: t.name } })) as typeof video.tags;
      }

      // Fire-and-forget: the response returns as soon as the bytes are safely on disk and the row
      // exists, matching how push notifications are dispatched elsewhere in this codebase. The
      // client polls/receives the status transition rather than holding a request open for a
      // transcode that can take minutes.
      void enqueueTranscode(video.id);

      reply.code(201);
      return serializeVideoWithStatus(video);
    },
  );

  /**
   * Turn remixing of one of your own videos on or off after the fact.
   *
   * Consent is not a one-shot decision made in an upload form: someone who discovers their video
   * being duetted in a way they dislike needs a way to stop it that doesn't involve deleting the
   * video. Existing derivatives are deliberately left alone — they were made with permission, and
   * retroactively unpublishing someone else's work because the source author changed their mind
   * later is a different and much bigger decision than "no more from here".
   */
  fastify.patch("/:id/remix-settings", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const body = request.body as { allowStitch?: boolean; allowDuet?: boolean };
    const video = await loadVideo((request.params as { id: string }).id);
    if (video.authorId !== request.userId) throw new NotFoundError("Video not found");

    const updated = await prisma.video.update({
      where: { id: video.id },
      data: {
        ...(typeof body.allowStitch === "boolean" ? { allowStitch: body.allowStitch } : {}),
        ...(typeof body.allowDuet === "boolean" ? { allowDuet: body.allowDuet } : {}),
      },
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });
    return serializeVideoWithStatus(updated);
  });

  /** Everything made from this video — the other half of attribution. A creator whose clip is
   * being remixed should be able to find the remixes, not only be credited inside them. */
  fastify.get("/:id/derivatives", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const source = await loadVideo((request.params as { id: string }).id);
    const query = request.query as { before?: string; limit?: string };
    const cursor = parseCursor(query.before);

    const videos = await prisma.video.findMany({
      where: {
        sourceVideoId: source.id,
        // APPROVED only, whoever is asking. A pending derivative is not public, and leaking its
        // existence to the source's author is still leaking it.
        status: "APPROVED",
        ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: parseLimit(query.limit),
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });

    const liked = await prisma.videoLike.findMany({
      where: { userId: request.userId!, videoId: { in: videos.map((v) => v.id) } },
      select: { videoId: true },
    });
    const likedIds = new Set(liked.map((l) => l.videoId));
    return { videos: videos.map((v) => serializeVideo(v, likedIds.has(v.id))) };
  });

  /** The uploader's own videos, every status included — this is the only place a user can find
   * out that their upload is awaiting review, was rejected, or failed to transcode. */
  fastify.get("/mine", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const userId = request.userId!;
    const query = request.query as { before?: string; limit?: string };
    const cursor = parseCursor(query.before);
    const limit = parseLimit(query.limit);

    const videos = await prisma.video.findMany({
      where: { authorId: userId, ...(cursor !== undefined ? { id: { lt: cursor } } : {}) },
      orderBy: { id: "desc" },
      take: limit,
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });
    return videos.map((v) => serializeVideoWithStatus(v));
  });

  fastify.get("/:id", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const video = await loadVideo((request.params as { id: string }).id);
    // A non-approved video is visible only to its own uploader and to staff; to everyone else it
    // is indistinguishable from nonexistent (404, not 403 — a 403 would confirm the id is real
    // and leak that a specific pending/rejected video exists).
    const viewer = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { platformRole: true },
    });
    const isOwner = video.authorId === request.userId;
    const privileged = isOwner || isStaff(viewer?.platformRole);
    if (video.status !== "APPROVED" && !privileged) {
      throw new NotFoundError("Video not found");
    }
    // Moderation fields only for the uploader and staff — a third party viewing an approved video
    // has no business seeing who reviewed it or what an earlier rejection said.
    return privileged ? serializeVideoWithStatus(video) : serializeVideo(video, false);
  });

  fastify.get("/:id/playback", async (request, reply) => {
    const userId = extractMediaUserId(request);
    const video = await loadVideo((request.params as { id: string }).id);
    await assertCanViewMedia(video, userId);
    if (!video.playbackKey) throw new NotFoundError("Video is still processing");

    const filePath = path.join(VIDEO_DIRS.playback(), video.playbackKey);
    const size = await statSize(filePath);
    if (size === null) throw new NotFoundError("Video file not found on disk");

    // Metered on the requested range, not the whole file: players fetch a video in many small
    // ranges, so counting full size per request would overstate egress by orders of magnitude.
    recordBandwidth("video", rangeLength(request.headers.range, size));

    return sendFileWithRange(reply, filePath, {
      mimeType: "video/mp4",
      sizeBytes: size,
      rangeHeader: request.headers.range,
    });
  });

  fastify.get("/:id/thumbnail", async (request, reply) => {
    const userId = extractMediaUserId(request);
    const video = await loadVideo((request.params as { id: string }).id);
    await assertCanViewMedia(video, userId);
    if (!video.thumbnailKey) throw new NotFoundError("Thumbnail is still processing");

    const filePath = path.join(VIDEO_DIRS.thumbs(), video.thumbnailKey);
    const size = await statSize(filePath);
    if (size === null) throw new NotFoundError("Thumbnail file not found on disk");
    recordBandwidth("video", size);

    return sendFileWithRange(reply, filePath, {
      mimeType: "image/jpeg",
      sizeBytes: size,
      rangeHeader: request.headers.range,
    });
  });
}

/** Bytes a Range request will actually transfer. Falls back to the full size when no Range header
 * is present, which is the case for a plain whole-file fetch. */
function rangeLength(header: string | undefined, size: number): number {
  if (!header) return size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return size;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd !== "") return Math.min(Number(rawEnd), size);
  const start = Number(rawStart || 0);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return Math.max(0, end - start + 1);
}

async function loadVideo(rawId: string) {
  const id = parseBigIntId(rawId);
  if (id === null) throw new NotFoundError("Video not found");
  const video = await prisma.video.findUnique({
    where: { id },
    include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
  });
  if (!video) throw new NotFoundError("Video not found");
  return video;
}

/**
 * Media bytes follow the same visibility rule as the metadata AND the same age gate as the feed
 * that lists them. The video feed is adults-only (requireAdult on every /feed route), but the
 * playback/thumbnail URLs are hit directly by native <video>/<img> elements and so cannot carry a
 * preHandler — the age check has to live here, or it doesn't exist for the bytes at all. Without
 * it a minor account (permitted to exist, blocked from the feed) could stream the entire
 * adults-only library by incrementing the sequential video id, defeating the whole point of the
 * age separation.
 *
 * Order matters: the uploader always sees their own media (any status, any age), staff see
 * anything, and only then is a non-owner held to "APPROVED and you're a confirmed adult". Unknown
 * age fails exactly like requireAdult — an unanswered age is never permission. 404 rather than 403
 * throughout so a probing id can't tell "exists but blocked" apart from "doesn't exist".
 */
async function assertCanViewMedia(
  video: { status: string; authorId: string | null },
  userId: string,
): Promise<void> {
  if (video.authorId === userId) return;

  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true, isMinor: true, ageRecordedAt: true },
  });
  if (isStaff(viewer?.platformRole)) return;

  // Non-owner, non-staff: only APPROVED media is visible at all, and only to a confirmed adult.
  if (video.status !== "APPROVED") throw new NotFoundError("Video not found");
  if (!viewer || viewer.ageRecordedAt === null || viewer.isMinor) throw new NotFoundError("Video not found");
}

/** Rolling 24-hour window rather than a calendar day, so the cap can't be doubled by uploading
 * either side of midnight. Failed/rejected uploads still count — otherwise the cheapest way to
 * bypass it is to upload garbage that fails fast. */
async function assertDailyQuota(userId: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.video.count({ where: { authorId: userId, createdAt: { gte: since } } });
  if (count >= env.MAX_VIDEO_UPLOADS_PER_DAY) {
    throw new TooManyRequestsError(
      `Upload limit reached (${env.MAX_VIDEO_UPLOADS_PER_DAY} per day). Try again later.`,
    );
  }
}

interface ResolvedRemix {
  sourceId: bigint;
  type: "STITCH" | "DUET";
  startMs: number | null;
  endMs: number | null;
}

/**
 * Validates a stitch/duet request against the source video, or returns null for a plain upload.
 *
 * Everything here is a server-side check with a UI equivalent, and the UI equivalent is the part
 * that doesn't count. A client that simply doesn't render the Duet button is not consent
 * enforcement — the flag has to be checked on the request that creates the derivative, because
 * that request is trivially made by hand.
 */
async function resolveRemix(
  userId: string,
  fields: { stitchOf: string; duetOf: string; stitchStartMs: string; stitchEndMs: string },
): Promise<ResolvedRemix | null> {
  const raw = fields.stitchOf || fields.duetOf;
  if (!raw) return null;
  if (fields.stitchOf && fields.duetOf) {
    throw new BadRequestError("A video can be either a stitch or a duet, not both");
  }

  const sourceId = parseBigIntId(raw);
  if (sourceId === null) throw new BadRequestError("That isn't a valid video id");

  const source = await prisma.video.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      status: true,
      authorId: true,
      durationMs: true,
      allowStitch: true,
      allowDuet: true,
      derivativeType: true,
    },
  });
  // Not "403 you may not remix this": an unapproved video is not visible to this user at all, and
  // saying otherwise confirms a specific pending or rejected id exists.
  if (!source || source.status !== "APPROVED") throw new NotFoundError("Video not found");

  // Chains are refused rather than supported. Each duet halves the width of everything before it,
  // so a duet of a duet of a duet is a column of postage stamps, and the attribution a viewer
  // actually cares about ("who is this a reply to") gets buried at an arbitrary depth.
  if (source.derivativeType) {
    throw new BadRequestError("That video is itself a remix — remix the original instead");
  }

  // A block in either direction. Being able to pull someone's face into a side-by-side with your
  // own after they blocked you would make blocking meaningless in the one place it matters most.
  if (source.authorId && source.authorId !== userId) {
    const blocked = await prisma.friendRequest.findFirst({
      where: {
        status: "BLOCKED",
        OR: [
          { requesterId: userId, addresseeId: source.authorId },
          { requesterId: source.authorId, addresseeId: userId },
        ],
      },
      select: { id: true },
    });
    if (blocked) throw new NotFoundError("Video not found");
  }

  if (fields.duetOf) {
    if (!source.allowDuet) throw new BadRequestError("Duets are turned off for that video");
    return { sourceId, type: "DUET", startMs: null, endMs: null };
  }

  if (!source.allowStitch) throw new BadRequestError("Stitches are turned off for that video");

  const startMs = Math.max(0, Math.round(Number(fields.stitchStartMs) || 0));
  const endMs = Math.round(Number(fields.stitchEndMs));
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    throw new BadRequestError("Choose which part of the video to stitch");
  }
  const length = endMs - startMs;
  if (length < MIN_STITCH_MS || length > MAX_STITCH_MS) {
    throw new BadRequestError(`A stitch can use between ${MIN_STITCH_MS / 1000}s and ${MAX_STITCH_MS / 1000}s`);
  }
  if (source.durationMs !== null && endMs > source.durationMs) {
    throw new BadRequestError("That part of the video doesn't exist");
  }

  return { sourceId, type: "STITCH", startMs, endMs };
}
