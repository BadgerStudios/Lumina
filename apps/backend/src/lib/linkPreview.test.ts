import { describe, expect, it } from "vitest";
import { extractUrls, normalizeUrl, parsePreview } from "./linkPreview.js";

describe("extractUrls", () => {
  it("finds http and https links", () => {
    expect(extractUrls("see https://example.com and http://other.test")).toEqual([
      "https://example.com/",
      "http://other.test/",
    ]);
  });

  it("drops the punctuation that ends a sentence rather than a URL", () => {
    // Without this, "see https://example.com." fetches `example.com.` — a different host as far as
    // DNS is concerned, and a preview that silently never appears.
    expect(extractUrls("see https://example.com.")).toEqual(["https://example.com/"]);
    expect(extractUrls("https://example.com/a,")).toEqual(["https://example.com/a"]);
    expect(extractUrls("(https://example.com/a)")).toEqual(["https://example.com/a"]);
  });

  it("keeps balanced parentheses inside a URL", () => {
    // Wikipedia URLs contain these legitimately.
    expect(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("deduplicates and caps at three", () => {
    const text = "https://a.test https://a.test https://b.test https://c.test https://d.test";
    expect(extractUrls(text)).toEqual(["https://a.test/", "https://b.test/", "https://c.test/"]);
  });

  it("ignores non-http schemes", () => {
    expect(extractUrls("file:///etc/passwd and ftp://x.test")).toEqual([]);
  });
});

describe("normalizeUrl", () => {
  it("drops the fragment and lowercases the host", () => {
    // The fragment never reaches the server, so two URLs differing only after # are one fetch.
    expect(normalizeUrl("https://EXAMPLE.com/path#section")).toBe("https://example.com/path");
  });

  it("keeps the query string", () => {
    // A query routinely decides what a page *is* — stripping it would collapse every video on a
    // site onto one cache entry.
    expect(normalizeUrl("https://example.com/watch?v=abc")).toBe("https://example.com/watch?v=abc");
  });

  it("strips embedded credentials", () => {
    expect(normalizeUrl("https://user:pass@example.com/")).toBe("https://example.com/");
  });

  it("refuses non-http schemes and nonsense", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("parsePreview", () => {
  const base = "https://example.com/article";

  it("reads OpenGraph tags", () => {
    const html = `<html><head>
      <meta property="og:title" content="A Title">
      <meta property="og:description" content="A description.">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="https://cdn.example.com/x.png">
    </head><body>ignored</body></html>`;
    expect(parsePreview(html, base)).toEqual({
      title: "A Title",
      description: "A description.",
      siteName: "Example",
      imageUrl: "https://cdn.example.com/x.png",
    });
  });

  it("falls back to twitter cards, then to <title>", () => {
    const twitter = `<head><meta name="twitter:title" content="TW"></head>`;
    expect(parsePreview(twitter, base).title).toBe("TW");

    const plain = `<head><title>Just A Title</title></head>`;
    expect(parsePreview(plain, base).title).toBe("Just A Title");
  });

  it("decodes entities", () => {
    const html = `<head><meta property="og:title" content="Tom &amp; Jerry &mdash; &quot;fun&quot;"></head>`;
    expect(parsePreview(html, base).title).toBe('Tom & Jerry — "fun"');
  });

  it("resolves a relative og:image against the page", () => {
    const html = `<head><meta property="og:image" content="/img/hero.png"></head>`;
    expect(parsePreview(html, base).imageUrl).toBe("https://example.com/img/hero.png");
  });

  it("refuses a plain-http og:image", () => {
    // An http image would be blocked as mixed content by the browser anyway, and would hand every
    // viewer's IP to that host in cleartext if it weren't.
    const html = `<head><meta property="og:image" content="http://cdn.example.com/x.png"></head>`;
    expect(parsePreview(html, base).imageUrl).toBeNull();
  });

  it("ignores meta tags that appear after </head>", () => {
    // Only the head is parsed, so a page that streams a megabyte of body costs nothing extra — and
    // a body that repeats og: tags cannot override what the head declared.
    const html = `<head><meta property="og:title" content="Real"></head><body><meta property="og:title" content="Fake"></body>`;
    expect(parsePreview(html, base).title).toBe("Real");
  });

  it("handles single-quoted and unquoted attributes", () => {
    expect(parsePreview(`<head><meta property='og:title' content='Single'></head>`, base).title).toBe("Single");
    expect(parsePreview(`<head><meta property=og:title content=Bare></head>`, base).title).toBe("Bare");
  });

  it("returns nulls for a page with nothing usable", () => {
    expect(parsePreview("<html><body>hi</body></html>", base)).toEqual({
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
    });
  });
});
