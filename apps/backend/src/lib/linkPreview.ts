import { createHash } from "node:crypto";
import { ServerEvents } from "@lumina/shared";
import { prisma } from "../db/prisma.js";
import { safeFetch, BlockedUrlError } from "./safeFetch.js";
import { enqueueLinkPreview } from "../modules/messages/previewQueue.js";
import { emitToRoom } from "../realtime/emitBridge.js";

/**
 * Link unfurling: the message text goes in, an OpenGraph card comes out.
 *
 * Three properties this is built around, in order of how much they matter:
 *
 * 1. **It never runs in the send path.** `scheduleLinkPreviews` writes rows and enqueues, and that
 *    is all it does. The fetch happens on the worker container. A message send must never be
 *    slowed by, or able to fail because of, a remote host someone else chose.
 * 2. **The fetch itself is hardened** — see lib/safeFetch.ts, which is where the SSRF defence
 *    actually lives.
 * 3. **Results are cached per URL, including the failures.** A link that will never produce a card
 *    must not be refetched every time it is posted, or reposting one URL becomes a way to aim this
 *    server's outbound requests at a target repeatedly.
 */

/** How long an OK preview is trusted before a repost refetches it. */
const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Negative results are held much longer — they are the ones a re-post could otherwise weaponise. */
const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Beyond this many links in one message, the rest are ignored. */
const MAX_LINKS_PER_MESSAGE = 3;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/**
 * Strips the trailing punctuation that ends a sentence rather than a URL.
 *
 * "see https://example.com." must not fetch `example.com.` — and the closing-paren case has to
 * count, because Wikipedia URLs legitimately contain balanced parens.
 */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (last === ")" ) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes <= opens) break;
      url = url.slice(0, -1);
      continue;
    }
    if (".,;:!?'\"".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/**
 * Canonical form for cache identity. The fragment never reaches the server so two URLs differing
 * only after `#` are the same fetch; the host is lowercased because DNS is case-insensitive.
 * Query strings are deliberately preserved — they routinely change what a page is.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function hashUrl(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

export function extractUrls(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(URL_RE)) {
    const normalized = normalizeUrl(trimUrl(match[0]));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_LINKS_PER_MESSAGE) break;
  }
  return out;
}

/**
 * Fire-and-forget by design; see the note at the top of this file. Deliberately swallows every
 * error, because the only caller is the message-send path and a failure to schedule an unfurl is
 * not a reason for someone's message to fail.
 */
export function scheduleLinkPreviews(params: { messageId: bigint; content: string; room: string }): void {
  const urls = extractUrls(params.content);
  if (urls.length === 0) return;

  void (async () => {
    try {
      const previewIds: string[] = [];
      for (const url of urls) {
        const urlHash = hashUrl(url);
        // Upsert rather than find-then-create: two people posting the same link in the same second
        // would otherwise both create a row and one would lose to the unique index.
        const preview = await prisma.linkPreview.upsert({
          where: { urlHash },
          create: { urlHash, url, status: "PENDING" },
          update: {},
        });
        previewIds.push(preview.id);

        await prisma.messageEmbed.upsert({
          where: { messageId_previewId: { messageId: params.messageId, previewId: preview.id } },
          create: { messageId: params.messageId, previewId: preview.id, position: previewIds.length - 1 },
          update: {},
        });

        if (needsFetch(preview)) {
          await enqueueLinkPreview({ previewId: preview.id, messageId: params.messageId.toString(), room: params.room });
        }
      }

      // A cache hit means there is nothing to wait for and the message was broadcast without its
      // embeds a moment ago — push them now rather than making every reader wait for a refresh.
      await broadcastEmbeds(params.messageId, params.room);
    } catch {
      /* an unfurl that never happens is invisible; a send that fails is not */
    }
  })();
}

function needsFetch(preview: { status: string; fetchedAt: Date | null }): boolean {
  if (preview.status === "PENDING") return true;
  if (!preview.fetchedAt) return true;
  const age = Date.now() - preview.fetchedAt.getTime();
  return preview.status === "OK" ? age > OK_TTL_MS : age > NEGATIVE_TTL_MS;
}

const META_RE = /<meta\b[^>]*>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/** The handful of entities that actually show up in title/description text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        mdash: "—",
        ndash: "–",
        hellip: "…",
        rsquo: "’",
        lsquo: "‘",
        ldquo: "“",
        rdquo: "”",
      };
      return named[entity.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: string | null, max: number): string | null {
  if (!value) return null;
  const trimmed = decodeEntities(value);
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface ParsedPreview {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

/**
 * OpenGraph/Twitter Card tags, by regex over the raw bytes.
 *
 * No DOM parser and no script execution on purpose. A full parser on untrusted HTML is a much
 * bigger attack surface than a regex over meta tags, and there is nothing here worth that: the
 * whole job is reading four string attributes out of `<head>`.
 */
export function parsePreview(html: string, baseUrl: string): ParsedPreview {
  // Everything of interest lives in the head; stopping there also means a page that closes its
  // head and then streams a megabyte of body costs nothing extra to parse.
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);

  const meta = new Map<string, string>();
  for (const match of head.matchAll(META_RE)) {
    const tag = match[0];
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (!key || content === null) continue;
    if (!meta.has(key)) meta.set(key, content);
  }

  const titleTag = TITLE_RE.exec(head);
  const title = clamp(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag?.[1] ?? null, 200);
  const description = clamp(
    meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? null,
    400,
  );
  const siteName = clamp(meta.get("og:site_name") ?? null, 100);

  let imageUrl: string | null = null;
  const rawImage = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? null;
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage), baseUrl);
      // Only https images are kept. An http one would be blocked as mixed content by the browser
      // anyway, and would leak every viewer's IP to that host in cleartext if it weren't.
      if (resolved.protocol === "https:") imageUrl = resolved.toString().slice(0, 1000);
    } catch {
      /* an unparseable og:image just means no image */
    }
  }

  return { title, description, imageUrl, siteName };
}

/**
 * Runs on the worker. Fetches one preview and records the outcome — including, importantly, the
 * failures, which are cached as negatives rather than retried on the next post.
 */
export async function fetchPreview(previewId: string): Promise<void> {
  const preview = await prisma.linkPreview.findUnique({ where: { id: previewId } });
  if (!preview) return;

  try {
    const res = await safeFetch(preview.url);
    if (res.status >= 400 || res.body.length === 0) {
      await prisma.linkPreview.update({
        where: { id: previewId },
        data: { status: "EMPTY", fetchedAt: new Date(), failReason: `HTTP ${res.status}` },
      });
      return;
    }

    const parsed = parsePreview(res.body.toString("utf8"), res.finalUrl);
    // A card with no title and no description is a blank rectangle. Cached as EMPTY so it is not
    // fetched again for a month.
    const usable = parsed.title !== null || parsed.description !== null;
    await prisma.linkPreview.update({
      where: { id: previewId },
      data: {
        status: usable ? "OK" : "EMPTY",
        title: parsed.title,
        description: parsed.description,
        imageUrl: parsed.imageUrl,
        siteName: parsed.siteName,
        fetchedAt: new Date(),
        failReason: usable ? null : "no OpenGraph tags",
      },
    });
  } catch (err) {
    const blocked = err instanceof BlockedUrlError;
    await prisma.linkPreview.update({
      where: { id: previewId },
      data: {
        status: blocked ? "BLOCKED" : "FAILED",
        fetchedAt: new Date(),
        failReason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      },
    });
  }
}

/**
 * Pushes finished embeds to whoever is looking at the conversation.
 *
 * Without this the card only appears on a reload, which reads as "link previews don't work" rather
 * than "link previews are a second late".
 */
export async function broadcastEmbeds(messageId: bigint, room: string): Promise<void> {
  const embeds = await prisma.messageEmbed.findMany({
    where: { messageId },
    include: { preview: true },
    orderBy: { position: "asc" },
  });
  const ready = embeds.filter((e) => e.preview.status === "OK");
  if (ready.length === 0) return;

  // Via the bridge, not getIO(): the common case is being called from the worker, which has no
  // Socket.IO server at all. See realtime/emitBridge.ts.
  await emitToRoom(room, ServerEvents.MESSAGE_EMBEDS_UPDATE, {
    messageId: messageId.toString(),
    embeds: ready.map((e) => ({
      url: e.preview.url,
      title: e.preview.title,
      description: e.preview.description,
      imageUrl: e.preview.imageUrl,
      siteName: e.preview.siteName,
    })),
  });
}
