import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { extractMediaUserId } from "../../lib/mediaAuth.js";
import { sendFileWithRange } from "../../lib/sendFile.js";
import { recordBandwidth } from "../metrics/service.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";

/**
 * Membership-checked streaming of message attachments. Auth is deliberately NOT the shared
 * `requireAuth` preHandler — see lib/mediaAuth.ts for why these routes accept a `?token=` query
 * param in addition to a Bearer header.
 */

/** Mounted under /api/files */
/** Types a browser may render inline from a user upload. Anything else downloads as an opaque blob. */
const INLINE_SAFE = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/flac", "audio/aac",
]);
export function safeAttachmentType(declared: string | null | undefined): { mimeType: string; inline: boolean } {
  const type = String(declared || "").split(";")[0].trim().toLowerCase();
  if (INLINE_SAFE.has(type)) return { mimeType: type, inline: true };
  return { mimeType: "application/octet-stream", inline: false };
}

export default async function uploadsRoutes(fastify: FastifyInstance) {
  fastify.get("/:attachmentId", async (request, reply) => {
    const userId = extractMediaUserId(request);
    const { attachmentId } = request.params as { attachmentId: string };

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: {
        message: {
          include: { channel: true },
        },
      },
    });
    if (!attachment) throw new NotFoundError("Attachment not found");

    const message = attachment.message;

    // Deleting a message is a soft delete, and this route never looked at it — so the file stayed
    // fetchable by anyone who had seen the message and kept the id. "Delete" has to mean the
    // attachment goes too, since retracting something posted by mistake is the main reason anyone
    // deletes a message at all.
    if (message.deletedAt) throw new NotFoundError("Attachment not found");

    // Taken down in review. The bytes are unlinked at the same time, so this is belt and
    // braces — but the row is the authority, and an unlink that failed must not leave the
    // image quietly fetchable by anyone who kept the id.
    if (attachment.reviewStatus === "REMOVED") throw new NotFoundError("Attachment not found");

    if (message.channelId && message.channel) {
      const membership = await prisma.membership.findUnique({
        where: { userId_serverId: { userId, serverId: message.channel.serverId } },
      });
      if (!membership) throw new ForbiddenError("Not a member of this server");
    } else if (message.dmConversationId) {
      const participant = await prisma.dMParticipant.findUnique({
        where: { conversationId_userId: { conversationId: message.dmConversationId, userId } },
      });
      if (!participant) throw new ForbiddenError("Not a participant in this conversation");
    } else {
      throw new NotFoundError("Attachment not found");
    }

    const filePath = path.join(env.UPLOADS_DIR, "attachments", attachmentId);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundError("File not found on disk");
    }

    // Range-capable (see lib/sendFile.ts): a video or audio attachment posted in chat was
    // previously unseekable, and unplayable outright on Safari/iOS, because this replied with a
    // whole-file 200 and no Accept-Ranges. Images are unaffected — they never send a Range.
    recordBandwidth("attachment", attachment.sizeBytes);

    // The stored type is whatever the uploader's client DECLARED. Replaying it as Content-Type on
    // this origin let a member post a text/html "attachment" that loads a text/javascript one —
    // both same-origin, both allowed by script-src 'self' — and run script with any clicker's
    // session (2026-09-08 audit). Only types a browser can render harmlessly are served inline;
    // everything else is a download with an opaque type, and SVG/HTML/JS/XML never render here.
    const served = safeAttachmentType(attachment.mimeType);
    return sendFileWithRange(reply, filePath, {
      mimeType: served.mimeType,
      sizeBytes: attachment.sizeBytes,
      rangeHeader: request.headers.range,
      fileName: attachment.fileName,
      inline: served.inline,
    });
  });
}
