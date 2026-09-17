import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { GifPageDTO } from "@lumina/shared";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { extractMediaUserId } from "../../lib/mediaAuth.js";
import { AppError, BadRequestError, NotFoundError } from "../../lib/errors.js";
import type { CreateMessageAttachmentInput } from "../messages/service.js";
import {
  KLIPY_API_BASE,
  KLIPY_MEDIA_HOST,
  clampPage,
  contentFilterFor,
  customerIdFor,
  isMediaPath,
  mediaTypeForPath,
  normalizeItems,
  normalizeQuery,
  pickSendRendition,
  redactKey,
  type KlipyItem,
  type KlipyPage,
} from "./klipy.js";

/**
 * GIF picker backend (KLIPY). See klipy.ts for why every byte goes through here.
 *
 *   GET  /api/gifs/config            { enabled } — the composer hides the button without a key
 *   GET  /api/gifs/trending?page=    one page of trending GIFs
 *   GET  /api/gifs/search?q=&page=   one page of search results
 *   GET  /api/gifs/media/ii/...      a preview file, fetched from KLIPY's static host only
 *
 * Sending is not here: the composer posts `gifSlug` with an ordinary message (the same route a
 * sticker or a poll uses), and the message routes call gifAttachment() below — so a GIF gets every
 * check a message gets (membership, ATTACH_FILES, slow mode, automod, rate limits, blocks).
 *
 * Search results are cached in Redis for everyone: KLIPY's testing keys allow 100 requests an hour,
 * and the same few trending pages and popular searches are what people open most.
 */

const TRENDING_TTL_S = 15 * 60;
const SEARCH_TTL_S = 60 * 60;
const ITEM_TTL_S = 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 6000;
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const PER_PAGE = 24;

export function gifsConfigured(): boolean {
  return Boolean(env.KLIPY_API_KEY?.trim());
}

class GifServiceError extends AppError {
  constructor(message = "GIF search isn't available right now. Try again in a moment.") {
    super(503, message, "GIFS_UNAVAILABLE");
  }
}

async function klipyGet<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const key = env.KLIPY_API_KEY?.trim();
  if (!key) throw new GifServiceError("GIFs aren't set up on this server.");
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${KLIPY_API_BASE}/${encodeURIComponent(key)}${endpoint}${qs ? `?${qs}` : ""}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[gifs] KLIPY ${endpoint} answered ${res.status}`);
      throw new GifServiceError(res.status === 429 ? "GIF search is busy. Try again in a few minutes." : undefined);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof GifServiceError) throw error;
    // eslint-disable-next-line no-console
    console.warn("[gifs] KLIPY request failed:", redactKey(error instanceof Error ? error.message : String(error), key));
    throw new GifServiceError();
  }
}

async function cached<T>(cacheKey: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await redis.get(cacheKey).catch(() => null);
  if (hit) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      /* fall through and refetch */
    }
  }
  const value = await load();
  await redis.set(cacheKey, JSON.stringify(value), "EX", ttl).catch(() => undefined);
  return value;
}

async function viewerFilter(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isMinor: true, ageRecordedAt: true } });
  return contentFilterFor(user);
}

/** One KLIPY item by slug (for sending), cached for a day. */
async function gifItem(slug: string, filter: string): Promise<KlipyItem | null> {
  if (!/^[a-z0-9-]{1,120}$/i.test(slug)) return null;
  return cached(`gifs:v1:item:${filter}:${slug}`, ITEM_TTL_S, async () => {
    const page = await klipyGet<KlipyPage>("/gifs/items", { slugs: slug });
    return page?.data?.data?.find((it) => it?.slug === slug && it?.type !== "ad") ?? null;
  });
}

/**
 * Downloads the GIF a person picked and stores it as an attachment, ready for createChannelMessage /
 * createDMMessage. Stored rather than linked: the message must not depend on KLIPY keeping the file,
 * and readers must not fetch it from KLIPY.
 */
export async function gifAttachment(slug: string, userId: string): Promise<CreateMessageAttachmentInput> {
  if (!gifsConfigured()) throw new GifServiceError("GIFs aren't set up on this server.");
  const item = await gifItem(slug, await viewerFilter(userId));
  if (!item) throw new NotFoundError("That GIF isn't available any more.");
  const pick = pickSendRendition(item);
  if (!pick) throw new NotFoundError("That GIF isn't available any more.");
  let bytes: Buffer;
  try {
    const res = await fetch(`https://${KLIPY_MEDIA_HOST}${pick.path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MEDIA_MAX_BYTES) throw new Error("too large");
    bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MEDIA_MAX_BYTES || bytes.length === 0) throw new Error("bad size");
  } catch {
    throw new GifServiceError("Couldn't fetch that GIF. Try another one.");
  }
  const dir = path.join(env.UPLOADS_DIR, "attachments");
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  await fs.writeFile(path.join(dir, id), bytes);
  const ext = pick.path.slice(pick.path.lastIndexOf(".") + 1);
  return {
    id,
    fileName: `${slug}.${ext}`,
    mimeType: mediaTypeForPath(pick.path),
    sizeBytes: bytes.length,
    url: `/api/files/${id}`,
    width: pick.width,
    height: pick.height,
  };
}

/** Removes a stored GIF whose message was refused (no permission, slow mode, automod…). */
export async function discardGifAttachment(attachment: CreateMessageAttachmentInput): Promise<void> {
  if (!attachment.id || !/^[0-9a-f-]{36}$/.test(attachment.id)) return;
  await fs.unlink(path.join(env.UPLOADS_DIR, "attachments", attachment.id)).catch(() => undefined);
}

/** KLIPY's share trigger (improves their ranking). Fire-and-forget: a failure changes nothing here. */
export function recordGifShare(slug: string, userId: string, query: string | null): void {
  const key = env.KLIPY_API_KEY?.trim();
  if (!key || !/^[a-z0-9-]{1,120}$/i.test(slug)) return;
  void fetch(`${KLIPY_API_BASE}/${encodeURIComponent(key)}/gifs/share/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customer_id: customerIdFor(userId), ...(query ? { q: query } : {}) }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => undefined);
}

/** Mounted under /api/gifs */
export default async function gifRoutes(fastify: FastifyInstance) {
  fastify.get("/config", { preHandler: [requireAuth] }, async () => ({ enabled: gifsConfigured() }));

  fastify.get(
    "/trending",
    { preHandler: [requireAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request): Promise<GifPageDTO> => {
      const page = clampPage((request.query as { page?: string }).page);
      const filter = await viewerFilter(request.userId!);
      const result = await cached(`gifs:v1:trending:${filter}:${page}`, TRENDING_TTL_S, async () =>
        normalizeItems(
          await klipyGet<KlipyPage>("/gifs/trending", {
            page: String(page),
            per_page: String(PER_PAGE),
            customer_id: customerIdFor(request.userId!),
            content_filter: filter,
            format_filter: "webp,gif",
          }),
        ),
      );
      return { ...result, page };
    },
  );

  fastify.get(
    "/search",
    { preHandler: [requireAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request): Promise<GifPageDTO> => {
      const query = request.query as { q?: string; page?: string };
      const q = normalizeQuery(query.q);
      if (!q) throw new BadRequestError("Type something to search for");
      const page = clampPage(query.page);
      const filter = await viewerFilter(request.userId!);
      const result = await cached(`gifs:v1:search:${filter}:${page}:${q.toLowerCase()}`, SEARCH_TTL_S, async () =>
        normalizeItems(
          await klipyGet<KlipyPage>("/gifs/search", {
            q,
            page: String(page),
            per_page: String(PER_PAGE),
            customer_id: customerIdFor(request.userId!),
            content_filter: filter,
            format_filter: "webp,gif",
          }),
        ),
      );
      return { ...result, page };
    },
  );

  // Preview files. Signed-in viewers only (the same media auth attachments use), KLIPY's static host
  // only, and only paths shaped like its content-addressed files — never a general-purpose proxy.
  fastify.get("/media/*", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    extractMediaUserId(request);
    const p = `/${(request.params as { "*": string })["*"] ?? ""}`;
    if (!isMediaPath(p)) throw new NotFoundError("Not found");
    let res: Response;
    try {
      res = await fetch(`https://${KLIPY_MEDIA_HOST}${p}`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    } catch {
      throw new GifServiceError("Couldn't load that preview.");
    }
    if (!res.ok) throw new NotFoundError("Not found");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MEDIA_MAX_BYTES) throw new NotFoundError("Not found");
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MEDIA_MAX_BYTES) throw new NotFoundError("Not found");
    // KLIPY's file names are content hashes, so a preview never changes under the same path.
    reply.header("content-type", mediaTypeForPath(p));
    reply.header("cache-control", "private, max-age=604800, immutable");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(body);
  });
}
