import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth, requireMembership, requirePermission, resolveServerId } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { serializeSound } from "../../lib/serialize.js";
import { probeAudio } from "../../lib/audioProbe.js";

/**
 * Soundboard clips.
 *
 * Playback is not here — it is a voice-room Socket.IO relay (realtime/handlers/voice.ts). This
 * module only manages the library.
 *
 * ## Why the file is probed rather than trusted
 *
 * A soundboard clip is the one upload in this app that plays automatically on other people's
 * devices without them choosing to open it. That makes "the client said it was 2 seconds of audio"
 * the wrong basis for anything: the duration cap has to come from the file, and the file has to be
 * confirmed to actually be audio. ffprobe already ships in this image for video transcoding, so the
 * check costs nothing new.
 *
 * MANAGE_EMOJI governs this for the same reason it governs stickers — see modules/stickers/routes.ts.
 */

const MAX_SOUNDS_PER_SERVER = 40;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Discord's own limit, and about right: a soundboard clip is a punctuation mark, not a track. */
const MAX_DURATION_MS = 5_200;

const createSchema = z.object({
  name: z.string().trim().min(2).max(32),
  // One emoji, or nothing. Length-capped rather than pattern-matched: emoji are several code points
  // (skin tone, ZWJ sequences) and a regex that tries to be clever here rejects real ones.
  emoji: z.string().trim().max(16).optional(),
});

/** Mounted under /api/servers. */
export default async function soundboardRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/:id/sounds",
    { preHandler: [requireAuth, requireMembership(resolveServerId.fromParam("id"))] },
    async (request) => {
      const sounds = await prisma.soundboardSound.findMany({
        where: { serverId: request.serverId! },
        orderBy: { name: "asc" },
      });
      return sounds.map(serializeSound);
    },
  );

  fastify.post(
    "/:id/sounds",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request) => {
      const parts = request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      let name = "";
      let emoji = "";
      let buffer: Buffer | null = null;
      let sourceMime = "";

      for await (const part of parts) {
        if (part.type === "field" && part.fieldname === "name") {
          name = String(part.value);
        } else if (part.type === "field" && part.fieldname === "emoji") {
          emoji = String(part.value);
        } else if (part.type === "file") {
          // Buffered rather than streamed, unlike video: the ceiling here is 2MB, and ffprobe
          // needs a file on disk anyway. At this size the memory cost is not worth the complexity
          // of a streaming write plus a cleanup path.
          buffer = await part.toBuffer();
          sourceMime = part.mimetype;
          if (part.file.truncated) throw new BadRequestError("Sound must be 2MB or smaller");
          break;
        }
      }

      const parsed = createSchema.safeParse({ name: name.trim(), emoji: emoji.trim() || undefined });
      if (!parsed.success) throw new BadRequestError(parsed.error.errors[0]?.message ?? "Invalid sound name");
      if (!buffer || buffer.length === 0) throw new BadRequestError("An audio file is required");

      const count = await prisma.soundboardSound.count({ where: { serverId: request.serverId! } });
      if (count >= MAX_SOUNDS_PER_SERVER) {
        throw new BadRequestError(`This server has reached the ${MAX_SOUNDS_PER_SERVER} sound limit`);
      }
      const clash = await prisma.soundboardSound.findUnique({
        where: { serverId_name: { serverId: request.serverId!, name: parsed.data.name } },
      });
      if (clash) throw new BadRequestError(`A sound called "${parsed.data.name}" already exists here`);

      const dir = path.join(env.UPLOADS_DIR, "sounds");
      await fs.mkdir(dir, { recursive: true });
      // A UUID, never anything derived from what the uploader called the file. Written without an
      // extension first because the extension has to come from ffprobe, and ffprobe needs the file
      // on disk to tell us.
      const id = randomUUID();
      const tempPath = path.join(dir, `${id}.upload`);
      await fs.writeFile(tempPath, buffer);

      let durationMs: number;
      let extension: string;
      try {
        const probed = await probeAudio(tempPath);
        if (!probed.hasAudio) throw new BadRequestError("That file doesn't contain any audio");
        if (probed.durationMs > MAX_DURATION_MS) {
          throw new BadRequestError(`Sounds must be ${(MAX_DURATION_MS / 1000).toFixed(1)}s or shorter`);
        }
        durationMs = probed.durationMs;
        extension = probed.extension;
      } catch (err) {
        // The bytes are already written, so every rejection path has to remove them — otherwise a
        // rejected upload still consumes disk forever, with no row pointing at it to find it by.
        await fs.unlink(tempPath).catch(() => undefined);
        throw err instanceof BadRequestError ? err : new BadRequestError("That file isn't a readable audio file");
      }

      // Renamed to carry the *probed* container's extension, so static serving infers the right
      // Content-Type. Naming it from the uploaded filename would serve a WAV as audio/mpeg the
      // moment someone renamed one to .mp3, and it simply would not decode.
      const fileName = `${id}.${extension}`;
      await fs.rename(tempPath, path.join(dir, fileName));

      const sound = await prisma.soundboardSound.create({
        data: {
          serverId: request.serverId!,
          name: parsed.data.name,
          audioUrl: `/sounds/${fileName}`,
          emoji: parsed.data.emoji ?? null,
          durationMs,
          sizeBytes: buffer.length,
          uploaderId: request.userId!,
        },
      });

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "sound.create",
        targetId: sound.id,
        targetType: "sound",
        metadata: { name: sound.name, durationMs, sourceMime },
      });

      return serializeSound(sound);
    },
  );

  fastify.delete(
    "/:id/sounds/:soundId",
    {
      preHandler: [
        requireAuth,
        requireMembership(resolveServerId.fromParam("id")),
        requirePermission(Permissions.MANAGE_EMOJI),
      ],
    },
    async (request, reply) => {
      const { soundId } = request.params as { soundId: string };
      // Server-scoped lookup, not by id alone — see the equivalent note in modules/stickers.
      const existing = await prisma.soundboardSound.findFirst({
        where: { id: soundId, serverId: request.serverId! },
      });
      if (!existing) throw new NotFoundError("Sound not found");

      await prisma.soundboardSound.delete({ where: { id: soundId } });

      const match = /^\/sounds\/([^/]+)$/.exec(existing.audioUrl);
      if (match) {
        // basename collapses anything path-shaped that reached the column, so a stored value can
        // never make this unlink something outside the sounds directory.
        await fs.unlink(path.join(env.UPLOADS_DIR, "sounds", path.basename(match[1]))).catch(() => undefined);
      }

      await recordAuditLog({
        serverId: request.serverId!,
        actorId: request.userId!,
        actionType: "sound.delete",
        targetId: soundId,
        targetType: "sound",
        metadata: { name: existing.name },
      });

      reply.code(204);
    },
  );
}
