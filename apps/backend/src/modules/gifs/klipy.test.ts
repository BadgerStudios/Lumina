import { describe, expect, it } from "vitest";
import { clampPage, contentFilterFor, customerIdFor, isMediaPath, mediaPathFromUrl, normalizeItems, normalizeQuery, pickSendRendition, redactKey } from "./klipy.js";

const U = (name: string) => `https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/${name}`;
const item = (over: Record<string, unknown> = {}) => ({
  id: 1,
  slug: "hello-hi-662",
  title: "Hello",
  type: "gif",
  blur_preview: "data:image/jpeg;base64,AAAA",
  file: {
    md: { webp: { url: U("JUYsGsrc.webp"), width: 498, height: 498, size: 643490 }, gif: { url: U("8GCrVAB7.gif"), width: 498, height: 498, size: 3721260 } },
    sm: { webp: { url: U("SE72470w.webp"), width: 220, height: 220, size: 80118 }, gif: { url: U("y6iepZM7.gif"), width: 220, height: 220, size: 314884 } },
  },
  ...over,
});

describe("KLIPY media paths", () => {
  it("accepts only KLIPY's static files over https", () => {
    expect(mediaPathFromUrl(U("um0L4dFH.gif"))).toBe("/ii/935d7ab9d8c6202580a668421940ec81/14/af/um0L4dFH.gif");
    expect(mediaPathFromUrl(U("KkjHgST0WkvqPhrQBEj.webm"))).not.toBeNull();
    expect(mediaPathFromUrl("http://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/a1b2.gif")).toBeNull();
    expect(mediaPathFromUrl("https://evil.example/ii/935d7ab9d8c6202580a668421940ec81/14/af/a1b2.gif")).toBeNull();
    expect(mediaPathFromUrl("https://static.klipy.com.evil.example/ii/935d7ab9d8c6202580a668421940ec81/14/af/a1b2.gif")).toBeNull();
    expect(mediaPathFromUrl(`${U("a1b2c3.gif")}?x=1`)).toBeNull();
    expect(mediaPathFromUrl("https://static.klipy.com/ii/../../etc/passwd")).toBeNull();
    expect(isMediaPath("/ii/935d7ab9d8c6202580a668421940ec81/14/af/a1b2.html")).toBe(false);
    expect(isMediaPath("/ii/935d7ab9d8c6202580a668421940ec81/14/af/../a1b2.gif")).toBe(false);
  });
});

describe("normalizeItems", () => {
  it("maps items to previews behind the proxy and drops ads and malformed entries", () => {
    const out = normalizeItems({
      data: {
        data: [item(), item({ slug: "ad-1", type: "ad" }), item({ slug: "bad slug!" }), item({ slug: "no-files", file: {} })],
        has_next: true,
      },
    } as never);
    expect(out.hasNext).toBe(true);
    expect(out.items).toEqual([
      {
        slug: "hello-hi-662",
        title: "Hello",
        width: 220,
        height: 220,
        previewUrl: "/api/gifs/media/ii/935d7ab9d8c6202580a668421940ec81/14/af/SE72470w.webp",
        blurPreview: "data:image/jpeg;base64,AAAA",
      },
    ]);
  });
  it("survives an empty or broken response", () => {
    expect(normalizeItems({} as never)).toEqual({ items: [], hasNext: false });
    expect(normalizeItems({ data: { data: "nope" } } as never)).toEqual({ items: [], hasNext: false });
  });
});

describe("sending", () => {
  it("prefers the medium webp", () => {
    expect(pickSendRendition(item() as never)?.path.endsWith("JUYsGsrc.webp")).toBe(true);
  });
  it("falls back when the webp is missing or too large", () => {
    const big = item();
    (big.file as { md: { webp: { size: number } } }).md.webp.size = 20 * 1024 * 1024;
    expect(pickSendRendition(big as never)?.path.endsWith("SE72470w.webp")).toBe(true);
  });
});

describe("helpers", () => {
  it("customer ids are stable and not the user id", () => {
    expect(customerIdFor("cmabc")).toBe(customerIdFor("cmabc"));
    expect(customerIdFor("cmabc")).not.toContain("cmabc");
    expect(customerIdFor("cmabc")).toHaveLength(32);
  });
  it("filters strictly for minors and unknown ages", () => {
    expect(contentFilterFor(null)).toBe("high");
    expect(contentFilterFor({ isMinor: false, ageRecordedAt: null })).toBe("high");
    expect(contentFilterFor({ isMinor: true, ageRecordedAt: new Date() })).toBe("high");
    expect(contentFilterFor({ isMinor: false, ageRecordedAt: new Date() })).toBe("medium");
  });
  it("normalizes queries and pages", () => {
    expect(normalizeQuery("  happy   dance ")).toBe("happy dance");
    expect(normalizeQuery(5)).toBe("");
    expect(clampPage("3")).toBe(3);
    expect(clampPage("0")).toBe(1);
    expect(clampPage("abc")).toBe(1);
    expect(clampPage("999")).toBe(1);
  });
  it("never lets the key into a log line", () => {
    expect(redactKey("fetch https://api.klipy.com/api/v1/SECRETKEY/gifs failed", "SECRETKEY")).not.toContain("SECRETKEY");
  });
});
