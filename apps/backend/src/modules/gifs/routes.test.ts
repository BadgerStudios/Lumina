import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs";

const KEY = "test-klipy-key-123";
// vi.mock factories are hoisted above every other statement, so what they close over is hoisted too.
const { UPLOADS, cache } = vi.hoisted(() => ({ UPLOADS: `/tmp/lumina-gifs-test-${process.pid}`, cache: new Map<string, string>() }));
fs.mkdirSync(UPLOADS, { recursive: true });

vi.mock("../../config/env.js", () => ({ env: { KLIPY_API_KEY: "test-klipy-key-123", UPLOADS_DIR: UPLOADS } }));
vi.mock("../../db/prisma.js", () => ({
  prisma: { user: { findUnique: async () => ({ isMinor: false, ageRecordedAt: new Date("2020-01-01") }) } },
}));
vi.mock("../../db/redis.js", () => ({
  redis: {
    get: async (k: string) => cache.get(k) ?? null,
    set: async (k: string, v: string) => {
      cache.set(k, v);
      return "OK";
    },
  },
}));
vi.mock("../../plugins/authenticate.js", () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = "cmuser123";
  },
}));
vi.mock("../../lib/mediaAuth.js", () => ({ extractMediaUserId: () => "cmuser123" }));

const { default: gifRoutes, gifAttachment, discardGifAttachment } = await import("./routes.js");

const STATIC = "https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/";
const ITEM = {
  id: 1,
  slug: "hello-hi-662",
  title: "Hello",
  type: "gif",
  file: {
    md: { webp: { url: `${STATIC}JUYsGsrc.webp`, width: 498, height: 498, size: 6 } },
    sm: { webp: { url: `${STATIC}SE72470w.webp`, width: 220, height: 220, size: 5 } },
  },
};
const page = (items: unknown[], hasNext = false) => ({ result: true, data: { data: items, has_next: hasNext, current_page: 1 } });

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let respond: (url: string, init?: RequestInit) => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let app: FastifyInstance;
beforeEach(async () => {
  cache.clear();
  calls = [];
  respond = (url) => {
    if (url.includes("/gifs/trending")) return json(page([ITEM, { ...ITEM, slug: "an-ad", type: "ad" }], true));
    if (url.includes("/gifs/search")) return json(page([ITEM]));
    if (url.includes("/gifs/items")) return json(page([ITEM]));
    if (url.startsWith("https://static.klipy.com/")) return new Response(Buffer.from("RIFFxx"), { status: 200, headers: { "content-type": "image/webp" } });
    return new Response("nope", { status: 404 });
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }));
  app = Fastify();
  await app.register(gifRoutes, { prefix: "/api/gifs" });
  await app.ready();
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

describe("GET /api/gifs", () => {
  it("reports enabled when a key is set", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gifs/config" });
    expect(res.json()).toEqual({ enabled: true });
  });

  it("trending: asks KLIPY with the filter and a hashed customer id, hides ads, caches for everyone", async () => {
    const first = await app.inject({ method: "GET", url: "/api/gifs/trending?page=1" });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ page: 1, hasNext: true });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].previewUrl).toBe("/api/gifs/media/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp");
    expect(first.body).not.toContain(KEY);
    expect(first.body).not.toContain("static.klipy.com");
    const upstream = new URL(calls[0].url);
    expect(upstream.pathname).toBe(`/api/v1/${KEY}/gifs/trending`);
    expect(upstream.searchParams.get("content_filter")).toBe("medium");
    expect(upstream.searchParams.get("format_filter")).toBe("webp,gif");
    expect(upstream.searchParams.get("customer_id")).toMatch(/^[0-9a-f]{32}$/);
    expect(upstream.searchParams.get("customer_id")).not.toContain("cmuser123");

    await app.inject({ method: "GET", url: "/api/gifs/trending?page=1" });
    expect(calls).toHaveLength(1);
  });

  it("search: needs words, and serves repeat searches from the cache", async () => {
    expect((await app.inject({ method: "GET", url: "/api/gifs/search?q=%20%20" })).statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/api/gifs/search?q=Happy%20%20Dance&page=2" });
    expect(res.statusCode).toBe(200);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("Happy Dance");
    await app.inject({ method: "GET", url: "/api/gifs/search?q=happy%20dance&page=2" });
    expect(calls).toHaveLength(1);
  });

  it("upstream trouble becomes a 503 without leaking the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    respond = () => new Response("slow down", { status: 429 });
    const busy = await app.inject({ method: "GET", url: "/api/gifs/trending?page=3" });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().message ?? busy.body).toContain("busy");
    respond = () => {
      throw new Error(`connect ECONNREFUSED https://api.klipy.com/api/v1/${KEY}/gifs/trending`);
    };
    const down = await app.inject({ method: "GET", url: "/api/gifs/trending?page=4" });
    expect(down.statusCode).toBe(503);
    expect(down.body).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    warn.mockRestore();
  });
});

describe("GET /api/gifs/media", () => {
  it("proxies KLIPY static previews with their type", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gifs/media/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(calls[0].url).toBe(`${STATIC}SE72470w.webp`);
  });

  it("refuses anything that is not a KLIPY static file path, without fetching", async () => {
    for (const url of [
      "/api/gifs/media/etc/passwd",
      "/api/gifs/media/ii/935d7ab9d8c6202580a668421940ec81/14/af/x.html",
      "/api/gifs/media/ii/../../../latest/meta-data",
      "/api/gifs/media/ii/ZZZ/14/af/abcd.gif",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("sending a GIF", () => {
  it("stores the medium webp as an attachment file, and discards it on request", async () => {
    const attachment = await gifAttachment("hello-hi-662", "cmuser123");
    expect(attachment).toMatchObject({ fileName: "hello-hi-662.webp", mimeType: "image/webp", width: 498, height: 498, sizeBytes: 6 });
    expect(attachment.url).toBe(`/api/files/${attachment.id}`);
    const file = path.join(UPLOADS, "attachments", attachment.id!);
    expect(fs.readFileSync(file, "utf8")).toBe("RIFFxx");
    expect(calls.some((c) => c.url === `${STATIC}JUYsGsrc.webp`)).toBe(true);
    await discardGifAttachment(attachment);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a slug KLIPY does not know, and a malformed one without asking", async () => {
    respond = (url) => (url.includes("/gifs/items") ? json(page([])) : new Response("", { status: 404 }));
    await expect(gifAttachment("gone-gif-1", "cmuser123")).rejects.toThrow(/isn't available/);
    const before = calls.length;
    await expect(gifAttachment("../../etc", "cmuser123")).rejects.toThrow(/isn't available/);
    expect(calls.length).toBe(before);
  });
});
