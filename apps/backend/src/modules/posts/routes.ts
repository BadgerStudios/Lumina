import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { sendFileWithRange } from "../../lib/sendFile.js";
// safeAttachmentType lives with the attachment route that needed it first. Reused rather than
// re-derived: it is the rule that stops a file claiming to be an image from being SERVED as
// something a browser will execute, and two copies of that rule is one copy too many.
import { safeAttachmentType } from "../uploads/routes.js";
import { recordBandwidth } from "../metrics/service.js";
import { prisma } from "../../db/prisma.js";
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  listComments,
  listFeed,
  toggleCommentLike,
  toggleLike,
  type CreatePostMedia,
} from "./service.js";

/** Where post photos and videos live, alongside the other upload kinds. */
const POST_MEDIA_DIR = () => path.join(env.UPLOADS_DIR, "posts");

/** 25MB a file. Generous for a photo, deliberately modest for video — a long upload belongs in
 *  the video feed, which streams to disk rather than buffering (see modules/videos/storage.ts). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_FILES = 10;

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  author: z.string().optional(),
});

const createSchema = z.object({
  body: z.string().max(20000).default(""),
  /** Ids returned by POST /posts/media, in the order they should appear. */
  mediaIds: z.array(z.string()).max(MAX_MEDIA_FILES).default([]),
  sharedPostId: z.string().optional(),
});

const commentSchema = z.object({
  body: z.string().min(1).max(4000),
  parentId: z.string().optional(),
});

function bigintParam(value: string, what = "post"): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new NotFoundError(`${what} not found`);
  }
}

/**
 * The feed, mounted under /api/posts.
 *
 * Everything needs a signed-in account — there is no anonymous read. The feed is the one surface
 * where a stranger could otherwise enumerate what everybody on the platform has written, and a
 * login is a cheap thing to ask for that.
 *
 * ## Media is uploaded before the post exists
 *
 * A post is created from ids, not from a multipart body carrying both text and files. That way the
 * composer can upload while someone is still typing, a failed upload does not lose the words, and
 * the create route stays a small JSON call. Orphaned uploads — picked and then abandoned — are the
 * cost, and they are swept on a timer rather than left forever.
 */
export default async function postRoutes(fastify: FastifyInstance) {
  fastify.get("/", { preHandler: [requireAuth] }, async (request) => {
    const query = listSchema.parse(request.query ?? {});
    return listFeed({
      viewerId: request.userId!,
      limit: query.limit,
      cursor: query.cursor,
      authorId: query.author,
    });
  });

  fastify.get("/:id", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return getPost(bigintParam(id), request.userId!);
  });

  fastify.post("/", { schema: { body: createSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof createSchema>;
    const media = await claimMedia(body.mediaIds, request.userId!);
    return createPost({
      authorId: request.userId!,
      body: body.body,
      media,
      sharedPostId: body.sharedPostId ? bigintParam(body.sharedPostId) : null,
    });
  });

  fastify.delete("/:id", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    await deletePost(bigintParam(id), request.userId!);
    return { ok: true };
  });

  fastify.post("/:id/like", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return toggleLike(bigintParam(id), request.userId!);
  });

  // ── comments ──────────────────────────────────────────────────────────────

  fastify.get("/:id/comments", { preHandler: [requireAuth] }, async (request) => {
    const { id } = request.params as { id: string };
    return { comments: await listComments(bigintParam(id), request.userId!) };
  });

  fastify.post(
    "/:id/comments",
    { schema: { body: commentSchema }, preHandler: [requireAuth] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof commentSchema>;
      return {
        comments: await addComment({
          postId: bigintParam(id),
          authorId: request.userId!,
          body: body.body,
          parentId: body.parentId ? bigintParam(body.parentId, "comment") : null,
        }),
      };
    },
  );

  fastify.delete("/comments/:commentId", { preHandler: [requireAuth] }, async (request) => {
    const { commentId } = request.params as { commentId: string };
    await deleteComment(bigintParam(commentId, "comment"), request.userId!);
    return { ok: true };
  });

  fastify.post("/comments/:commentId/like", { preHandler: [requireAuth] }, async (request) => {
    const { commentId } = request.params as { commentId: string };
    return toggleCommentLike(bigintParam(commentId, "comment"), request.userId!);
  });

  // ── media ─────────────────────────────────────────────────────────────────

  /**
   * Upload one or more photos/videos and get ids back.
   *
   * The ids are meaningless until a post claims them, so an abandoned upload is a file on disk and
   * nothing else — no row, no visibility, nothing to enumerate.
   */
  fastify.post("/media", { preHandler: [requireAuth] }, async (request) => {
    if (!request.isMultipart()) throw new BadRequestError("Expected a file upload");
    await fs.mkdir(POST_MEDIA_DIR(), { recursive: true });

    const uploaded: CreatePostMedia[] = [];
    const partOpts = { limits: { fileSize: MAX_MEDIA_BYTES } };
    for await (const part of request.parts(partOpts as Parameters<typeof request.parts>[0])) {
      if (part.type !== "file") continue;
      if (uploaded.length >= MAX_MEDIA_FILES) break;

      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        if ((error as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE") {
          throw new BadRequestError(`"${part.filename}" is larger than the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB limit`);
        }
        throw error;
      }
      if (buffer.length > MAX_MEDIA_BYTES) {
        throw new BadRequestError(`"${part.filename}" is larger than the ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB limit`);
      }

      const declared = String(part.mimetype || "").split(";")[0].trim().toLowerCase();
      // Only pictures and video belong on a post. The check is on the declared type AND the served
      // type below is decided independently, so a file claiming to be an image cannot be served as
      // something executable.
      if (!declared.startsWith("image/") && !declared.startsWith("video/")) {
        throw new BadRequestError("Only photos and videos can go on a post");
      }

      const id = randomUUID();
      await fs.writeFile(path.join(POST_MEDIA_DIR(), id), buffer);
      uploaded.push({
        id,
        kind: declared.startsWith("video/") ? "VIDEO" : "PHOTO",
        url: `/api/posts/media/${id}`,
        mimeType: declared.slice(0, 100),
        sizeBytes: buffer.length,
      });
    }

    if (uploaded.length === 0) throw new BadRequestError("No files were uploaded");
    pendingMedia.set(request.userId!, [...(pendingMedia.get(request.userId!) ?? []), ...uploaded]);
    return { media: uploaded.map((m) => ({ id: m.id, kind: m.kind, url: m.url })) };
  });

  fastify.get("/media/:mediaId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { mediaId } = request.params as { mediaId: string };
    // basename, so a crafted id cannot walk out of the directory.
    const safeId = path.basename(mediaId);
    const row = await prisma.postMedia.findUnique({
      where: { id: safeId },
      select: { mimeType: true, sizeBytes: true, post: { select: { deletedAt: true } } },
    });
    // Unclaimed media has no row yet; only its uploader holds the id, and it becomes readable to
    // everyone the moment a post claims it.
    const pending = (pendingMedia.get(request.userId!) ?? []).find((m) => m.id === safeId);
    if (!row && !pending) throw new NotFoundError("Not found");
    if (row?.post?.deletedAt) throw new NotFoundError("Not found");

    const filePath = path.join(POST_MEDIA_DIR(), safeId);
    let sizeBytes = row?.sizeBytes ?? pending?.sizeBytes ?? 0;
    try {
      const stat = await fs.stat(filePath);
      // Trust the file on disk over the recorded size: a Range reply computed from a stale number
      // truncates the response, and a truncated video simply refuses to play.
      sizeBytes = stat.size;
    } catch {
      throw new NotFoundError("Not found");
    }

    recordBandwidth("attachment", sizeBytes);
    // The stored type is what the UPLOADER declared. Replaying it verbatim is how a same-origin
    // "image" becomes executable script (see the 2026-09-08 audit); safeAttachmentType decides what
    // is actually safe to serve inline and makes everything else an opaque download.
    const served = safeAttachmentType(row?.mimeType ?? pending?.mimeType ?? "application/octet-stream");
    return sendFileWithRange(reply, filePath, {
      mimeType: served.mimeType,
      sizeBytes,
      rangeHeader: request.headers.range,
      fileName: safeId,
      inline: served.inline,
    });
  });
}

/**
 * Uploads a person has made but not yet attached to a post.
 *
 * In memory rather than in a table: they live for the length of one composer session, and a row
 * per abandoned upload would be a table that only ever grows. A restart drops them, which costs
 * somebody a re-pick in the worst case and nothing at all in the normal one.
 */
const pendingMedia = new Map<string, CreatePostMedia[]>();

/** Turn ids from the composer back into media rows — only ones THIS person uploaded. */
async function claimMedia(ids: string[], userId: string): Promise<CreatePostMedia[]> {
  if (ids.length === 0) return [];
  const mine = pendingMedia.get(userId) ?? [];
  const claimed = ids
    .map((id) => mine.find((m) => m.id === id))
    .filter((m): m is CreatePostMedia => Boolean(m));
  // Whatever is left is still pending for this session; whatever was claimed is now a row.
  pendingMedia.set(userId, mine.filter((m) => !claimed.includes(m)));
  return claimed;
}

/**
 * Delete media nobody ever posted.
 *
 * An upload that is picked and then abandoned leaves a file with no row pointing at it. Swept
 * hourly against the directory rather than tracked, because the in-memory pending list does not
 * survive a restart and the files do.
 */
export async function sweepOrphanPostMedia(): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(POST_MEDIA_DIR());
  } catch {
    return 0;
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    const filePath = path.join(POST_MEDIA_DIR(), name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    // Only old files are candidates — a file uploaded a minute ago belongs to a composer someone
    // is still typing in, and deleting it would pull the picture out from under them.
    if (stat.mtimeMs > cutoff) continue;
    const row = await prisma.postMedia.findUnique({ where: { id: name }, select: { id: true } });
    if (row) continue;
    await fs.unlink(filePath).catch(() => {});
    removed += 1;
  }
  return removed;
}
