import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { sendFileWithRange } from "../../lib/sendFile.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { IF_DIRS, streamUploadToDisk, statSize, safeUnlink, UploadTooLargeError } from "./storage.js";
import { generateCode } from "./codes.js";
import { enqueueImageframe } from "./queue.js";
import { ifLog, type LogLevel } from "./logger.js";

const log = ifLog("api");

const ACCEPTED_VIDEO_MIME = /^video\/(mp4|quicktime|webm|x-matroska|x-m4v|mpeg|3gpp)$/;

/** The absolute base a plugin uses to build pull URLs. Defaults to the app URL; override with
 * IMAGEFRAME_PUBLIC_URL when the resolving link is fronted by upload.badgerstudios.net. */
function publicBase(): string {
  return (env.IMAGEFRAME_PUBLIC_URL || env.PUBLIC_APP_URL).replace(/\/+$/, "");
}

function manifestFor(row: {
  code: string;
  name: string;
  status: string;
  gridCols: number;
  gridRows: number;
  fps: number;
  frameCount: number | null;
  durationMs: number | null;
  paletteVersion: number | null;
  packKey: string | null;
  posterKey: string | null;
}) {
  const base = publicBase();
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    cols: row.gridCols,
    rows: row.gridRows,
    tile: 128,
    fps: row.fps,
    frameCount: row.frameCount,
    durationMs: row.durationMs,
    paletteVersion: row.paletteVersion,
    ready: row.status === "READY" && !!row.packKey,
    packUrl: `${base}/api/imageframe/${row.code}/pack`,
    posterUrl: row.posterKey ? `${base}/api/imageframe/${row.code}/poster` : null,
    resolveUrl: `${base}/api/imageframe/${row.code}`,
  };
}

/** Mounted under /api/imageframe (and reachable via upload.badgerstudios.net once the tunnel routes
 * that host at this backend). */
export default async function imageframeRoutes(fastify: FastifyInstance) {
  /**
   * Upload + prepare. A logged-in user posts a video and a name; we mint a code, store the source,
   * and enqueue the transcode that turns it into a cached palette frame-pack. Returns the code
   * immediately — the pack is prepared asynchronously and polled via GET /:code.
   */
  fastify.post(
    "/",
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 12, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      if (!request.isMultipart()) throw new BadRequestError("Expected a multipart upload");

      const part = await request.file({
        limits: { fileSize: env.MAX_IMAGEFRAME_MB * 1024 * 1024, files: 1 },
      });
      if (!part) throw new BadRequestError("No file provided");
      if (!ACCEPTED_VIDEO_MIME.test(part.mimetype)) {
        throw new BadRequestError(`Unsupported video type: ${part.mimetype}`);
      }

      const field = (name: string): string => {
        const f = part.fields?.[name];
        return f && !Array.isArray(f) && f.type === "field" ? String(f.value ?? "") : "";
      };

      const name = field("name").trim().slice(0, 60) || "Untitled";
      // Screen dimensions in maps. Clamped to sane bounds — a 20x20 screen is 400 maps and 6.5MP
      // per frame, which is neither placeable nor renderable at fps.
      const cols = clampGrid(field("cols"), env.IMAGEFRAME_DEFAULT_COLS, env.IMAGEFRAME_MAX_COLS);
      const rows = clampGrid(field("rows"), env.IMAGEFRAME_DEFAULT_ROWS, env.IMAGEFRAME_MAX_ROWS);
      const fps = env.IMAGEFRAME_FPS;

      const sourceKey = randomUUID();
      let uploaded: { sizeBytes: number; sha256: string };
      try {
        uploaded = await streamUploadToDisk(part, sourceKey);
      } catch (err) {
        if (err instanceof UploadTooLargeError) throw new BadRequestError(err.message);
        throw err;
      }
      if (uploaded.sizeBytes === 0) {
        await safeUnlink(path.join(IF_DIRS.source(), sourceKey));
        throw new BadRequestError("Uploaded file is empty");
      }

      const code = await generateCode();
      const row = await prisma.imageframeVideo.create({
        data: {
          code,
          name,
          ownerId: userId,
          status: "PROCESSING",
          sourceKey,
          mimeType: part.mimetype,
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256,
          gridCols: cols,
          gridRows: rows,
          fps,
          uploadIp: request.ip ?? null,
        },
      });
      await enqueueImageframe(row.id);
      log.info("upload accepted", { code, name, userId, cols, rows, fps, sizeBytes: uploaded.sizeBytes });

      return reply.code(201).send(manifestFor(row));
    },
  );

  // --- Public-by-code resolution -----------------------------------------------------------------
  // The code is the capability: a 30^6 unguessable token the uploader chooses to share into a game.
  // These reads are unauthenticated so the resolving link opens in a browser and the plugin needs no
  // credentials — but rate-limited hard, so the keyspace can't be swept.
  const readRate = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  async function loadByCode(request: FastifyRequest) {
    const { code } = request.params as { code: string };
    const row = await prisma.imageframeVideo.findUnique({ where: { code: code.toUpperCase() } });
    if (!row) throw new NotFoundError("No imageframe video with that code");
    return row;
  }

  fastify.get("/:code", readRate, async (request) => manifestFor(await loadByCode(request)));

  fastify.get("/:code/manifest", readRate, async (request) => manifestFor(await loadByCode(request)));

  fastify.get("/:code/pack", readRate, async (request, reply) => {
    const row = await loadByCode(request);
    if (row.status !== "READY" || !row.packKey) {
      // 425 Too Early: the plugin should back off and poll the manifest, not treat this as a hard
      // miss. A failed transcode is a 404 instead — there's nothing to wait for.
      if (row.status === "FAILED") throw new NotFoundError(row.failureReason ?? "Preparation failed");
      return reply.code(425).send({ status: row.status, message: "Still preparing — poll the manifest" });
    }
    const filePath = path.join(IF_DIRS.packs(), row.packKey);
    const sizeBytes = await statSize(filePath);
    if (sizeBytes == null) throw new NotFoundError("Pack missing on disk");
    log.debug("pack served", { code: row.code, sizeBytes });
    return sendFileWithRange(reply, filePath, {
      mimeType: "application/octet-stream",
      sizeBytes,
      rangeHeader: request.headers.range,
      fileName: `${row.code}.ifv`,
    });
  });

  fastify.get("/:code/poster", readRate, async (request, reply) => {
    const row = await loadByCode(request);
    if (!row.posterKey) throw new NotFoundError("No poster");
    const filePath = path.join(IF_DIRS.posters(), row.posterKey);
    const sizeBytes = await statSize(filePath);
    if (sizeBytes == null) throw new NotFoundError("Poster missing on disk");
    return sendFileWithRange(reply, filePath, {
      mimeType: "image/png",
      sizeBytes,
      rangeHeader: request.headers.range,
      fileName: `${row.code}.png`,
    });
  });

  /**
   * Plugin log ingest — the Minecraft side POSTs playback events and errors here so "issues from all
   * levels" land in the same imageframe log as the backend's own. Gated by IMAGEFRAME_LOG_TOKEN when
   * set; open (but rate-limited) when not, so it works out of the box during bring-up.
   */
  fastify.post(
    "/log",
    { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (env.IMAGEFRAME_LOG_TOKEN) {
        const auth = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (auth !== env.IMAGEFRAME_LOG_TOKEN) return reply.code(401).send({ error: "bad token" });
      }
      const body = (request.body ?? {}) as { level?: string; scope?: string; message?: string; fields?: Record<string, unknown> };
      const level: LogLevel = (["debug", "info", "warn", "error"].includes(String(body.level)) ? body.level : "info") as LogLevel;
      const scope = String(body.scope ?? "plugin").slice(0, 40);
      const message = String(body.message ?? "").slice(0, 500);
      ifLog(`plugin:${scope}`)[level](message, { ...(body.fields ?? {}), src: "minecraft", ip: request.ip });
      return reply.code(204).send();
    },
  );
}

function clampGrid(raw: string, fallback: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
