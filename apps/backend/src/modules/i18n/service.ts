import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LANGUAGE_CODES } from "@lumina/shared";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";

/**
 * Language packs: machine translations of the app's own interface text, English -> one of LANGUAGES.
 *
 * What gets translated is fixed at build time: scripts/extract-ui-strings.mjs collects every piece
 * of interface text in the frontend source into i18n/ui-strings.json. Only those strings are ever
 * sent to the engine, and only those are ever translated on screen — nothing a person writes is in
 * the source, so no message, name or bio can be translated or leave the browser for translation.
 *
 * The engine is the self-hosted LibreTranslate container (compose service `translate`); nothing
 * leaves our server. Every result is kept in TranslationCache keyed by (language, sha256 of the
 * English), so after the first warm-up a deploy only translates the strings that are new. When the
 * engine is down or a result is unusable, the English stands and nothing is cached, so the next
 * warm-up tries again.
 */

const ENGINE_BATCH = 40;
const ENGINE_TIMEOUT_MS = 60_000;
const WARM_RETRY_MS = 5 * 60_000;

export interface UiStrings {
  strings: string[];
  /** Interface text with ${} parts, as {0} {1}…; the frontend matches rendered text against them. */
  templates: string[];
}

export interface LanguagePack {
  lang: string;
  /** Changes whenever the set of texts or the number translated changes; the client's cache key. */
  version: string;
  /** False while some texts are still being translated; the client asks again later. */
  complete: boolean;
  strings: Record<string, string>;
  templates: Record<string, string>;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function isTranslatableTarget(lang: string): boolean {
  return lang !== "en" && LANGUAGE_CODES.includes(lang);
}

/** Our codes are LibreTranslate's except Chinese, which it names by script. */
export function engineCode(lang: string): string {
  return lang === "zh" ? "zh-Hans" : lang === "zt" ? "zh-Hant" : lang;
}

function engineUrl(): string {
  return (env.TRANSLATE_URL ?? "http://translate:5000").replace(/\/+$/, "");
}

let uiStringsCache: UiStrings | null = null;
export function loadUiStrings(): UiStrings {
  if (uiStringsCache) return uiStringsCache;
  try {
    // Relative to the working directory, not this file: the image runs a single bundled
    // dist/index.js from /app (i18n/ is copied beside it), and dev and tests run from apps/backend.
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "i18n/ui-strings.json"), "utf8")) as Partial<UiStrings>;
    uiStringsCache = { strings: raw.strings ?? [], templates: raw.templates ?? [] };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[i18n] no ui-strings.json; every language pack is empty:", error instanceof Error ? error.message : String(error));
    uiStringsCache = { strings: [], templates: [] };
  }
  return uiStringsCache;
}

/**
 * {0} is fragile in the engine (it drops it in Spanish, for one); X0 reads as a name and survives.
 * Tested across es/de/ja: every placeholder came back, in a grammatical position.
 */
export function encodePlaceholders(template: string): string {
  return template.replace(/\{(\d)\}/g, "X$1");
}

/** The translation with {n} restored, or null unless every placeholder came back exactly once. */
export function decodePlaceholders(template: string, translated: string): string | null {
  const wanted = [...template.matchAll(/\{(\d)\}/g)].map((m) => m[1]!);
  let out = translated;
  for (const n of wanted) {
    const re = new RegExp(`X${n}(?![0-9])`, "g");
    const hits = out.match(re)?.length ?? 0;
    if (hits !== 1) return null;
    out = out.replace(re, `{${n}}`);
  }
  return out;
}

/** Keeps the English's edges: surrounding whitespace, and a trailing ellipsis the engine turns into "..". */
export function tidyTranslation(source: string, translated: string): string | null {
  let core = translated.trim();
  if (!core) return null;
  if (source.endsWith("…")) core = core.replace(/\s*(\.{2,}|…)$/, "") + "…";
  const lead = source.match(/^\s*/)?.[0] ?? "";
  const trail = source.match(/\s*$/)?.[0] ?? "";
  return lead + core + trail;
}

/** One call to the engine; null when it could not answer. */
async function engineTranslate(lang: string, texts: string[]): Promise<string[] | null> {
  try {
    const res = await fetch(`${engineUrl()}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: texts, source: "en", target: engineCode(lang), format: "text" }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] engine answered ${res.status} for ${lang}`);
      return null;
    }
    const body = (await res.json()) as { translatedText?: unknown };
    const out = body.translatedText;
    if (!Array.isArray(out) || out.length !== texts.length || !out.every((t) => typeof t === "string")) return null;
    return out as string[];
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[i18n] engine request failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function cached(lang: string, texts: string[]): Promise<Map<string, string>> {
  const byHash = new Map(texts.map((t) => [textHash(t), t]));
  const rows = await prisma.translationCache.findMany({
    where: { lang, hash: { in: [...byHash.keys()] } },
    select: { hash: true, text: true },
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    const source = byHash.get(r.hash);
    if (source !== undefined) out.set(source, r.text);
  }
  return out;
}

/**
 * Translates whichever of `texts` are not cached yet for `lang`, and caches them. Templates (texts
 * with {n}) go through the placeholder encoding. Returns how many were translated now.
 */
export async function translateMissing(lang: string, texts: string[]): Promise<number> {
  if (!isTranslatableTarget(lang) || texts.length === 0) return 0;
  const have = await cached(lang, texts);
  const missing = [...new Set(texts)].filter((t) => !have.has(t));
  let done = 0;
  for (let i = 0; i < missing.length; i += ENGINE_BATCH) {
    const chunk = missing.slice(i, i + ENGINE_BATCH);
    const out = await engineTranslate(lang, chunk.map((t) => encodePlaceholders(t.trim())));
    if (!out) break;
    const data: Array<{ lang: string; hash: string; source: string; text: string }> = [];
    chunk.forEach((source, j) => {
      const decoded = decodePlaceholders(source, out[j]!);
      const text = decoded === null ? null : tidyTranslation(source, decoded);
      // An unusable result is cached as the English itself, so it is not re-sent on every warm-up;
      // the pack leaves out anything equal to the English.
      data.push({ lang, hash: textHash(source), source, text: text ?? source });
    });
    await prisma.translationCache.createMany({ data, skipDuplicates: true });
    done += data.length;
  }
  return done;
}

const packCache = new Map<string, LanguagePack>();

export async function buildPack(lang: string): Promise<LanguagePack> {
  const ui = loadUiStrings();
  const all = [...ui.strings, ...ui.templates];
  if (!isTranslatableTarget(lang)) {
    return { lang, version: `${lang}-${textHash(all.join("\n")).slice(0, 12)}`, complete: true, strings: {}, templates: {} };
  }
  const hit = packCache.get(lang);
  if (hit?.complete) return hit;
  const have = await cached(lang, all);
  const strings: Record<string, string> = {};
  const templates: Record<string, string> = {};
  for (const s of ui.strings) {
    const t = have.get(s);
    if (t !== undefined && t !== s) strings[s] = t;
  }
  for (const s of ui.templates) {
    const t = have.get(s);
    if (t !== undefined && t !== s) templates[s] = t;
  }
  const pack: LanguagePack = {
    lang,
    version: `${lang}-${textHash(all.join("\n")).slice(0, 12)}-${have.size}`,
    // An empty list means the file is missing, not that there is nothing to do: never "complete",
    // or browsers would keep an empty pack for an hour.
    complete: all.length > 0 && have.size >= new Set(all).size,
    strings,
    templates,
  };
  packCache.set(lang, pack);
  return pack;
}

let languagesCache: { at: number; codes: string[] } | null = null;

/** Which of our languages the engine can produce right now (it loads them one by one on first boot). */
export async function readyLanguages(): Promise<string[]> {
  if (languagesCache && Date.now() - languagesCache.at < 60_000) return languagesCache.codes;
  try {
    const res = await fetch(`${engineUrl()}/languages`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return languagesCache?.codes ?? ["en"];
    const list = (await res.json()) as Array<{ code?: string }>;
    const codes = new Set(list.map((l) => l.code));
    const ready = LANGUAGE_CODES.filter((c) => c === "en" || codes.has(engineCode(c)));
    languagesCache = { at: Date.now(), codes: ready };
    return ready;
  } catch {
    return languagesCache?.codes ?? ["en"];
  }
}

let warming = false;

/**
 * Brings every language pack up to date with the current ui-strings.json: on boot, then again every
 * few minutes until nothing is left (the engine may still be loading, or down). One pass at a time.
 */
export function startTranslationWarmer(): void {
  const pass = async () => {
    if (warming) return;
    warming = true;
    let incomplete = false;
    try {
      const ui = loadUiStrings();
      const all = [...ui.strings, ...ui.templates];
      if (all.length === 0) return;
      const ready = new Set(await readyLanguages());
      for (const lang of LANGUAGE_CODES) {
        if (lang === "en") continue;
        if (!ready.has(lang)) { incomplete = true; continue; }
        const started = Date.now();
        const n = await translateMissing(lang, all);
        packCache.delete(lang);
        const pack = await buildPack(lang);
        if (!pack.complete) incomplete = true;
        // eslint-disable-next-line no-console
        if (n > 0) console.log(`[i18n] ${lang}: translated ${n} in ${Math.round((Date.now() - started) / 1000)}s, pack ${pack.complete ? "complete" : "partial"}`);
      }
    } catch (error) {
      incomplete = true;
      // eslint-disable-next-line no-console
      console.warn("[i18n] warm-up failed:", error instanceof Error ? error.message : String(error));
    } finally {
      warming = false;
      if (incomplete) setTimeout(() => void pass(), WARM_RETRY_MS).unref();
    }
  };
  setTimeout(() => void pass(), 15_000).unref();
}
