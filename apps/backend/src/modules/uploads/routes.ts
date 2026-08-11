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

    return sendFileWithRange(reply, filePath, {
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      rangeHeader: request.headers.range,
      fileName: attachment.fileName,
    });
  });
}
