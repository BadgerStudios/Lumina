import { AUTO_LANGUAGE, LANGUAGE_CODES, languageInfo, pickAutoLanguage } from "@lumina/shared";
import { resolveAssetUrl } from "../apiClient";
import { usePreferencesStore } from "../../store/preferencesStore";
import { showPack, type LanguagePack } from "./autoTranslate";

/**
 * Which language the interface is in, and getting its pack onto the screen.
 *
 * The choice lives in account preferences (preferences.locale.language: a code, or "auto"), with a
 * copy in this device's storage so the signed-out screens and the very first paint of a cold start
 * use it too. "auto" means: the device's own language if we have it and it is not English, else the
 * language of the country the connection comes from (Cloudflare's header, via /api/i18n/locale),
 * else English.
 *
 * The last pack is kept in storage, so a returning person sees their language immediately and the
 * network only refreshes it; a pack that is still being filled in is asked for again a few times.
 */

const CHOICE_KEY = "lumina.i18n.choice";
const PACK_KEY = "lumina.i18n.pack";
const COUNTRY_KEY = "lumina.i18n.country";
const COUNTRY_TTL_MS = 24 * 60 * 60 * 1000;
const PARTIAL_RETRY_MS = 3 * 60 * 1000;
const PARTIAL_RETRIES = 10;

let current = "en";
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(lang: string) => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or full storage: this device just re-downloads next time.
  }
}

function storedPack(lang: string): LanguagePack | null {
  const raw = read(PACK_KEY);
  if (!raw) return null;
  try {
    const pack = JSON.parse(raw) as LanguagePack;
    return pack.lang === lang ? pack : null;
  } catch {
    return null;
  }
}

async function country(): Promise<string | null> {
  const raw = read(COUNTRY_KEY);
  if (raw) {
    try {
      const saved = JSON.parse(raw) as { country: string | null; at: number };
      if (Date.now() - saved.at < COUNTRY_TTL_MS) return saved.country;
    } catch {
      // fall through and ask again
    }
  }
  try {
    const res = await fetch(resolveAssetUrl("/api/i18n/locale"), { credentials: "omit" });
    if (!res.ok) return null;
    const body = (await res.json()) as { country: string | null };
    write(COUNTRY_KEY, JSON.stringify({ country: body.country, at: Date.now() }));
    return body.country;
  } catch {
    return null;
  }
}

export async function resolveLanguage(choice: string): Promise<string> {
  if (choice !== AUTO_LANGUAGE && LANGUAGE_CODES.includes(choice)) return choice;
  const device = typeof navigator !== "undefined" ? [...(navigator.languages ?? [navigator.language])] : [];
  return pickAutoLanguage(await country(), device);
}

function setDocumentLanguage(lang: string): void {
  document.documentElement.lang = languageInfo(lang)?.htmlLang ?? "en";
}

async function fetchPack(lang: string, attempt: number, gen: number): Promise<void> {
  let pack: LanguagePack | null = null;
  try {
    const res = await fetch(resolveAssetUrl(`/api/i18n/pack/${lang}`), { credentials: "omit" });
    if (res.ok) pack = (await res.json()) as LanguagePack;
  } catch {
    // Offline: the stored pack (if any) stays on screen.
  }
  if (gen !== generation) return;
  if (pack) {
    const had = storedPack(lang);
    if (!had || had.version !== pack.version) {
      write(PACK_KEY, JSON.stringify(pack));
      showPack(pack);
    }
  }
  if ((!pack || !pack.complete) && attempt < PARTIAL_RETRIES) {
    retryTimer = setTimeout(() => void fetchPack(lang, attempt + 1, gen), PARTIAL_RETRY_MS);
  }
}

/** Puts the interface into the language `choice` resolves to. */
export async function applyLanguageChoice(choice: string): Promise<void> {
  write(CHOICE_KEY, choice);
  const gen = ++generation;
  if (retryTimer) clearTimeout(retryTimer);
  const lang = await resolveLanguage(choice);
  if (gen !== generation) return;
  current = lang;
  setDocumentLanguage(lang);
  listeners.forEach((fn) => fn(lang));
  if (lang === "en") {
    showPack(null);
    return;
  }
  const stored = storedPack(lang);
  showPack(stored);
  await fetchPack(lang, 0, gen);
}

/** The language the interface is in right now (resolved, never "auto"). */
export function currentLanguage(): string {
  return current;
}

export function onLanguageChange(fn: (lang: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Called once before the first render: shows the stored pack at once, then settles the language
 * from this device's saved choice, and follows the account preference once it has loaded.
 */
export function startLanguage(): void {
  if (typeof document === "undefined") return;
  const choice = read(CHOICE_KEY) ?? AUTO_LANGUAGE;
  const onBody = () => {
    const raw = read(PACK_KEY);
    if (raw) {
      try {
        const pack = JSON.parse(raw) as LanguagePack;
        if (pack.lang !== "en") {
          current = pack.lang;
          setDocumentLanguage(pack.lang);
          showPack(pack);
        }
      } catch {
        write(PACK_KEY, null);
      }
    }
    void applyLanguageChoice(choice);
  };
  if (document.body) onBody();
  else document.addEventListener("DOMContentLoaded", onBody, { once: true });

  usePreferencesStore.subscribe((state, prev) => {
    if (!state.loaded) return;
    const next = state.prefs.locale.language;
    if (!prev.loaded) {
      // First load after signing in. A language picked on this device before the account had one
      // (still "auto") is carried over to the account rather than thrown away.
      const local = read(CHOICE_KEY) ?? AUTO_LANGUAGE;
      if (next === AUTO_LANGUAGE && local !== AUTO_LANGUAGE) {
        void state.update({ locale: { language: local } });
        return;
      }
      if (next !== local) void applyLanguageChoice(next);
      return;
    }
    if (next !== prev.prefs.locale.language) void applyLanguageChoice(next);
  });
}
