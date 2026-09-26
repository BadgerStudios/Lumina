import { beforeEach, describe, expect, it, vi } from "vitest";
import { languageFromTag, pickAutoLanguage } from "@lumina/shared";

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../config/env.js", () => ({ env: { TRANSLATE_URL: "http://engine.test" } }));
vi.mock("../../db/prisma.js", () => ({
  prisma: {
    translationCache: {
      findMany: async ({ where }: { where: { lang: string; hash: { in: string[] } } }) =>
        where.hash.in.filter((h) => store.has(`${where.lang}:${h}`)).map((h) => ({ hash: h, text: store.get(`${where.lang}:${h}`)! })),
      createMany: async ({ data }: { data: Array<{ lang: string; hash: string; text: string }> }) => {
        for (const d of data) store.set(`${d.lang}:${d.hash}`, d.text);
        return { count: data.length };
      },
    },
  },
}));

import { decodePlaceholders, encodePlaceholders, engineCode, isTranslatableTarget, textHash, tidyTranslation, translateMissing } from "./service.js";

describe("pickAutoLanguage", () => {
  it("uses the device language when it is one we have and not English", () => {
    expect(pickAutoLanguage("DE", ["fr-FR", "en"])).toBe("fr");
  });
  it("falls back to the country when the device is in English", () => {
    expect(pickAutoLanguage("DE", ["en-US", "de"])).toBe("de");
    expect(pickAutoLanguage("br", ["en"])).toBe("pt");
  });
  it("is English with no country and an English or unknown device", () => {
    expect(pickAutoLanguage(null, ["en-GB"])).toBe("en");
    expect(pickAutoLanguage("US", [])).toBe("en");
    expect(pickAutoLanguage("IN", ["en-IN"])).toBe("en");
  });
  it("skips device languages we do not have", () => {
    expect(pickAutoLanguage("MX", ["sw", "es-MX"])).toBe("es");
  });
});

describe("languageFromTag", () => {
  it("maps Chinese scripts and regions", () => {
    expect(languageFromTag("zh-CN")).toBe("zh");
    expect(languageFromTag("zh-Hant-TW")).toBe("zt");
    expect(languageFromTag("zh-HK")).toBe("zt");
  });
  it("maps Filipino and drops unknowns", () => {
    expect(languageFromTag("fil-PH")).toBe("tl");
    expect(languageFromTag("xx")).toBeNull();
    expect(languageFromTag("")).toBeNull();
  });
});

describe("helpers", () => {
  it("keeps the source's surrounding whitespace and its ellipsis", () => {
    expect(tidyTranslation(" Settings ", "Ajustes")).toBe(" Ajustes ");
    expect(tidyTranslation("Save", "  Guardar\n")).toBe("Guardar");
    expect(tidyTranslation("Save", "   ")).toBeNull();
    expect(tidyTranslation("Saving…", "Guardando..")).toBe("Guardando…");
  });
  it("round-trips placeholders and refuses a result that lost or doubled one", () => {
    expect(encodePlaceholders("{0} and {1} are typing…")).toBe("X0 and X1 are typing…");
    expect(decodePlaceholders("{0} and {1}", "X0 y X1")).toBe("{0} y {1}");
    expect(decodePlaceholders("{0} is calling", "está llamando")).toBeNull();
    expect(decodePlaceholders("{0}", "X0 X0")).toBeNull();
  });
  it("names Chinese the way the engine does", () => {
    expect(engineCode("zh")).toBe("zh-Hans");
    expect(engineCode("zt")).toBe("zh-Hant");
    expect(engineCode("es")).toBe("es");
  });
  it("never translates into English or unknown languages", () => {
    expect(isTranslatableTarget("en")).toBe(false);
    expect(isTranslatableTarget("xx")).toBe(false);
    expect(isTranslatableTarget("es")).toBe(true);
  });
});

describe("translateMissing", () => {
  beforeEach(() => {
    store.clear();
    vi.restoreAllMocks();
  });

  it("sends only what is not cached, encodes placeholders, and caches the results", async () => {
    const calls: Array<{ q: string[]; target: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { q: string[]; target: string };
      calls.push(body);
      return new Response(JSON.stringify({ translatedText: body.q.map((q) => `es:${q}`) }), { status: 200 });
    });
    expect(await translateMissing("es", ["Save", "Welcome back, {0}.", "Save"])).toBe(2);
    expect(calls).toEqual([{ q: ["Save", "Welcome back, X0."], source: "en", target: "es", format: "text" }]);
    expect(store.get(`es:${textHash("Welcome back, {0}.")}`)).toBe("es:Welcome back, {0}.");
    expect(await translateMissing("es", ["Save"])).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("caches a result that lost its placeholder as the English", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ translatedText: ["está llamando"] }), { status: 200 }));
    await translateMissing("es", ["{0} is calling"]);
    expect(store.get(`es:${textHash("{0} is calling")}`)).toBe("{0} is calling");
  });

  it("caches nothing when the engine is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await translateMissing("fr", ["Settings"])).toBe(0);
    expect(store.size).toBe(0);
  });

  it("does not touch the engine for English, and uses the engine's Chinese code", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { q: string[]; target: string };
      expect(body.target).toBe("zh-Hans");
      return new Response(JSON.stringify({ translatedText: body.q }), { status: 200 });
    });
    expect(await translateMissing("en", ["Settings"])).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await translateMissing("zh", ["Settings"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
