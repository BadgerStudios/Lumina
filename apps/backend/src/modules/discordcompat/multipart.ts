import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { BadRequestError } from "../../lib/errors.js";
import type { CreateMessageAttachmentInput } from "../messages/service.js";

/**
 * Discord's write bodies come two ways: plain JSON, or multipart/form-data with the JSON in a
 * `payload_json` field and files in `files[n]` parts. Every library switches to multipart the
 * moment a message carries a file, and JDA does so for some embed replies as well — Ree6's
 * /levelrole answer arrived that way and the compat layer, reading `request.body`, saw nothing
 * and refused it with "content or embeds required".
 *
 * Files are stored exactly as a person's uploads are (modules/messages/multipart.ts) and come
 * back as attachment inputs for createChannelMessage.
 */

export interface DiscordBody {
  body: Record<string, unknown>;
  attachments: CreateMessageAttachmentInput[];
}

/** Pure: the JSON body a set of multipart text fields describes. `payload_json` wins; loose fields fill in. */
export function mergeDiscordFields(fields: Array<{ name: string; value: string }>): Record<string, unknown> {
  let body: Record<string, unknown> = {};
  const loose: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === "payload_json") {
      try {
        const parsed = JSON.parse(f.value) as unknown;
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch {
        throw new BadRequestError("payload_json is not valid JSON");
      }
    } else {
      loose[f.name] = f.value;
    }
  }
  return { ...loose, ...body };
}

export async function readDiscordBody(request: FastifyRequest, maxFileBytes: number): Promise<DiscordBody> {
  if (!request.isMultipart()) {
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    return { body, attachments: [] };
  }
  const attachmentsDir = path.join(env.UPLOADS_DIR, "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });
  const fields: Array<{ name: string; value: string }> = [];
  const attachments: CreateMessageAttachmentInput[] = [];
  const partOpts = { limits: { fileSize: maxFileBytes } };
  for await (const part of request.parts(partOpts as Parameters<typeof request.parts>[0])) {
    if (part.type === "file" && part.fieldname === "payload_json") {
      // JDA labels this part `application/json`, and the multipart parser then hands it over as a
      // file rather than a text field. It is the body all the same.
      fields.push({ name: "payload_json", value: (await part.toBuffer()).toString("utf8") });
      continue;
    }
    if (part.type === "file") {
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        if ((error as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE") {
          throw new BadRequestError(`"${part.filename}" is larger than the ${Math.round(maxFileBytes / (1024 * 1024))}MB upload limit`);
        }
        throw error;
      }
      const attachmentId = randomUUID();
      await fs.writeFile(path.join(attachmentsDir, attachmentId), buffer);
      attachments.push({
        id: attachmentId,
        fileName: part.filename || "file",
        mimeType: String(part.mimetype || "application/octet-stream").split(";")[0].trim().toLowerCase().slice(0, 100),
        sizeBytes: buffer.length,
        url: `/api/files/${attachmentId}`,
      });
    } else {
      const value = part.value;
      fields.push({ name: part.fieldname, value: typeof value === "string" ? value : JSON.stringify(value ?? "") });
    }
  }
  return { body: mergeDiscordFields(fields), attachments };
}
