import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import type { CreateMessageAttachmentInput } from "./service.js";

/**
 * Shared by both channelMessagesRoutes.ts and dmMessagesRoutes.ts's POST /messages — a message
 * send is either a plain JSON body ({ content, replyToId }) or, when it carries file
 * attachments, a multipart form with the same two fields plus one or more `file` parts. Kept in
 * one place so channel and DM sends can never silently drift apart in how they parse this (DM
 * attachments were missing entirely until this was added — the multipart branch simply didn't
 * exist on the DM route).
 */
export async function parseMessageMultipart(
  request: FastifyRequest,
): Promise<{ content: string; replyToId: string | null; attachments: CreateMessageAttachmentInput[] }> {
  let content = "";
  let replyToId: string | null = null;
  const attachments: CreateMessageAttachmentInput[] = [];

  if (request.isMultipart()) {
    const attachmentsDir = path.join(env.UPLOADS_DIR, "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    for await (const part of request.parts()) {
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        // Attachment DB id is generated up front and used as the on-disk filename (no
        // extension — mimeType drives Content-Type when streaming), so `url` can point
        // straight at the id that GET /api/files/:attachmentId will look up.
        const attachmentId = randomUUID();
        await fs.writeFile(path.join(attachmentsDir, attachmentId), buffer);
        attachments.push({
          id: attachmentId,
          fileName: part.filename,
          mimeType: part.mimetype,
          sizeBytes: buffer.length,
          url: `/api/files/${attachmentId}`,
        });
      } else if (part.fieldname === "content") {
        content = String(part.value ?? "");
      } else if (part.fieldname === "replyToId") {
        replyToId = String(part.value ?? "") || null;
      }
    }
  } else {
    const body = request.body as { content?: string; replyToId?: string | null } | undefined;
    content = body?.content ?? "";
    replyToId = body?.replyToId ?? null;
  }

  return { content, replyToId, attachments };
}
