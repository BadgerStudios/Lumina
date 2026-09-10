import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import type { CreateMessageAttachmentInput } from "./service.js";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Shared by both channelMessagesRoutes.ts and dmMessagesRoutes.ts's POST /messages — a message
 * send is either a plain JSON body ({ content, replyToId }) or, when it carries file
 * attachments, a multipart form with the same two fields plus one or more `file` parts. Kept in
 * one place so channel and DM sends can never silently drift apart in how they parse this (DM
 * attachments were missing entirely until this was added — the multipart branch simply didn't
 * exist on the DM route).
 */
export interface ParsedMessageBody {
  content: string;
  replyToId: string | null;
  attachments: CreateMessageAttachmentInput[];
  stickerId: string | null;
  /**
   * Poll definition, as sent by the composer. Not a Poll id — the poll is created inside the same
   * request that creates its message, because an orphan poll with no message is unreachable.
   */
  poll: { question: string; options: string[]; allowMultiple?: boolean; durationHours?: number | null } | null;
}

export async function parseMessageMultipart(
  request: FastifyRequest,
  /**
   * The sender's own attachment ceiling. Applied to `request.parts()` per request, which is why
   * the plugin-level default can stay at the free limit and keep protecting every other upload
   * path. Premium raises it for this sender only.
   */
  maxFileBytes: number,
): Promise<ParsedMessageBody> {
  let content = "";
  let replyToId: string | null = null;
  let stickerId: string | null = null;
  let poll: ParsedMessageBody["poll"] = null;
  const attachments: CreateMessageAttachmentInput[] = [];

  if (request.isMultipart()) {
    const attachmentsDir = path.join(env.UPLOADS_DIR, "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    // Per-request limits are supported at runtime but typed only as a registration option, so
    // the cast is load-bearing rather than cosmetic — same workaround as modules/master/routes.ts.
    const partOpts = { limits: { fileSize: maxFileBytes } };
    for await (const part of request.parts(partOpts as Parameters<typeof request.parts>[0])) {
      if (part.type === "file") {
        let buffer: Buffer;
        try {
          buffer = await part.toBuffer();
        } catch (error) {
          // The plugin aborts the stream at the limit above and throws its own error, whose
          // message says nothing about whose limit it was or what to do about it.
          if ((error as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE") {
            throw new BadRequestError(
              `"${part.filename}" is larger than your ${Math.round(maxFileBytes / (1024 * 1024))}MB upload limit`,
            );
          }
          throw error;
        }
        // Belt and braces: if a future plugin version ever truncates instead of throwing, an
        // over-limit file must still not be stored.
        if (buffer.length > maxFileBytes) {
          throw new BadRequestError(
            `"${part.filename}" is larger than your ${Math.round(maxFileBytes / (1024 * 1024))}MB upload limit`,
          );
        }
        // Attachment DB id is generated up front and used as the on-disk filename (no
        // extension — mimeType drives Content-Type when streaming), so `url` can point
        // straight at the id that GET /api/files/:attachmentId will look up.
        const attachmentId = randomUUID();
        await fs.writeFile(path.join(attachmentsDir, attachmentId), buffer);
        attachments.push({
          id: attachmentId,
          fileName: part.filename,
          // Kept for display only — Content-Type on serve is decided by safeAttachmentType, never by this.
          mimeType: String(part.mimetype || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100),
          sizeBytes: buffer.length,
          url: `/api/files/${attachmentId}`,
        });
      } else if (part.fieldname === "content") {
        content = String(part.value ?? "");
      } else if (part.fieldname === "replyToId") {
        replyToId = String(part.value ?? "") || null;
      } else if (part.fieldname === "stickerId") {
        stickerId = String(part.value ?? "") || null;
      } else if (part.fieldname === "poll") {
        // A multipart field is a string, so the poll definition rides as JSON. Malformed JSON is
        // treated as "no poll" rather than throwing: the alternative is a 500 on a field the
        // sender may not even have meant to include.
        try {
          poll = JSON.parse(String(part.value ?? "")) as ParsedMessageBody["poll"];
        } catch {
          poll = null;
        }
      }
    }
  } else {
    const body = request.body as
      | { content?: string; replyToId?: string | null; stickerId?: string | null; poll?: ParsedMessageBody["poll"] }
      | undefined;
    content = body?.content ?? "";
    replyToId = body?.replyToId ?? null;
    stickerId = body?.stickerId ?? null;
    poll = body?.poll ?? null;
  }

  return { content, replyToId, attachments, stickerId, poll };
}
