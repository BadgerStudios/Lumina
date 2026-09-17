import { createHash } from "node:crypto";
import type { GifItemDTO } from "@lumina/shared";

/**
 * KLIPY, the GIF library behind the composer's GIF picker (Tenor's API shut down on 30 June 2026).
 *
 * Everything that touches KLIPY goes through the backend. The browser never loads KLIPY URLs:
 * the web build's CSP only allows same-origin images, and handing every reader's IP to a third
 * party on sight is exactly what lib/markdown.ts and LinkEmbeds.tsx refuse to do elsewhere. So
 * search results carry previews behind /api/gifs/media/..., and a GIF that is sent is downloaded
 * once and stored as an ordinary attachment.
 *
 * This file is the pure part (parsing, choosing variants, validating media paths) so it can be
 * tested without the network. The HTTP client and routes live in routes.ts.
 */

export const KLIPY_API_BASE = "https://api.klipy.com/api/v1";
export const KLIPY_MEDIA_HOST = "static.klipy.com";

type Rendition = { url?: unknown; width?: unknown; height?: unknown; size?: unknown };
type SizeSet = Partial<Record<"gif" | "webp" | "jpg" | "mp4" | "webm", Rendition>>;
export type KlipyItem = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  type?: unknown;
  blur_preview?: unknown;
  file?: Partial<Record<"hd" | "md" | "sm" | "xs", SizeSet>>;
};
export type KlipyPage = { result?: unknown; data?: { data?: KlipyItem[]; has_next?: unknown; current_page?: unknown } };

/** The only paths the media proxy will fetch: KLIPY's content-addressed static files. */
const MEDIA_PATH = /^\/ii\/[0-9a-f]{32}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[A-Za-z0-9_-]{4,64}\.(webp|gif|jpg|mp4|webm)$/;
export const MEDIA_TYPES: Record<string, string> = {
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** A KLIPY static URL → its path, or null for anything else. Pinning host AND path shape is what
 * keeps /api/gifs/media from being an open proxy. */
export function mediaPathFromUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== KLIPY_MEDIA_HOST || url.port || url.search || url.username) return null;
  return isMediaPath(url.pathname) ? url.pathname : null;
}

export function isMediaPath(p: string): boolean {
  return MEDIA_PATH.test(p);
}

export function mediaTypeForPath(p: string): string {
  return MEDIA_TYPES[p.slice(p.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

function rendition(set: SizeSet | undefined, format: keyof SizeSet) {
  const r = set?.[format];
  const path = mediaPathFromUrl(r?.url);
  const width = num(r?.width);
  const height = num(r?.height);
  if (!path || !width || !height) return null;
  return { path, width, height, size: num(r?.size) ?? 0 };
}

/** KLIPY's search/trending response → the picker's items. Ads and anything malformed are dropped. */
export function normalizeItems(page: KlipyPage): { items: GifItemDTO[]; hasNext: boolean } {
  const raw = Array.isArray(page?.data?.data) ? page.data!.data! : [];
  const items: GifItemDTO[] = [];
  for (const it of raw) {
    if (it?.type === "ad" || typeof it?.slug !== "string" || !/^[a-z0-9-]{1,120}$/i.test(it.slug)) continue;
    const preview = rendition(it.file?.sm, "webp") ?? rendition(it.file?.sm, "gif") ?? rendition(it.file?.xs, "webp") ?? rendition(it.file?.md, "webp");
    if (!preview) continue;
    const blur = typeof it.blur_preview === "string" && it.blur_preview.startsWith("data:image/") && it.blur_preview.length < 8000 ? it.blur_preview : null;
    items.push({
      slug: it.slug,
      title: typeof it.title === "string" ? it.title.slice(0, 120) : "",
      width: preview.width,
      height: preview.height,
      previewUrl: `/api/gifs/media${preview.path}`,
      blurPreview: blur,
    });
  }
  return { items, hasNext: page?.data?.has_next === true };
}

/** Largest animated file worth storing when a GIF is sent: webp first (a fraction of the gif's size). */
const SEND_LIMIT_BYTES = 8 * 1024 * 1024;
export function pickSendRendition(item: KlipyItem) {
  const candidates = [
    rendition(item.file?.md, "webp"),
    rendition(item.file?.hd, "webp"),
    rendition(item.file?.sm, "webp"),
    rendition(item.file?.md, "gif"),
    rendition(item.file?.sm, "gif"),
  ].filter((r): r is NonNullable<typeof r> => r !== null);
  return candidates.find((r) => r.size > 0 && r.size <= SEND_LIMIT_BYTES) ?? candidates.find((r) => r.size === 0) ?? null;
}

/** A stable, non-reversible id for KLIPY's personalisation: never the Lumina user id itself. */
export function customerIdFor(userId: string): string {
  return createHash("sha256").update(`lumina-klipy:${userId}`).digest("hex").slice(0, 32);
}

/** Minors, and anyone whose age was never recorded, get KLIPY's strictest filter. */
export function contentFilterFor(user: { isMinor: boolean; ageRecordedAt: Date | null } | null): "high" | "medium" {
  return !user || user.ageRecordedAt === null || user.isMinor ? "high" : "medium";
}

/** Search text as KLIPY and the cache key both see it. */
export function normalizeQuery(q: unknown): string {
  return typeof q === "string" ? q.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

export function clampPage(p: unknown): number {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1;
}

/** Strips the app key out of anything that might reach a log line. */
export function redactKey(text: string, key: string | undefined): string {
  return key ? text.split(key).join("<klipy-key>") : text;
}
