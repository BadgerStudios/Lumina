/**
 * Interface languages. The app is written in English; every other language here is produced by
 * machine translation on our own server (modules/i18n) and cached, never hand-maintained. `code` is
 * the code the translation engine uses and the value stored in preferences.locale.language.
 */
export interface LanguageInfo {
  code: string;
  /** The language's name in English. */
  name: string;
  /** The language's name in itself, which is what someone looking for their language recognises. */
  native: string;
  /** The BCP-47 tag for <html lang>, which screen readers and fonts key off. */
  htmlLang: string;
  rtl?: boolean;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { code: "en", name: "English", native: "English", htmlLang: "en" },
  { code: "es", name: "Spanish", native: "Español", htmlLang: "es" },
  { code: "pt", name: "Portuguese", native: "Português", htmlLang: "pt" },
  { code: "fr", name: "French", native: "Français", htmlLang: "fr" },
  { code: "de", name: "German", native: "Deutsch", htmlLang: "de" },
  { code: "it", name: "Italian", native: "Italiano", htmlLang: "it" },
  { code: "nl", name: "Dutch", native: "Nederlands", htmlLang: "nl" },
  { code: "sv", name: "Swedish", native: "Svenska", htmlLang: "sv" },
  { code: "pl", name: "Polish", native: "Polski", htmlLang: "pl" },
  { code: "ro", name: "Romanian", native: "Română", htmlLang: "ro" },
  { code: "ru", name: "Russian", native: "Русский", htmlLang: "ru" },
  { code: "uk", name: "Ukrainian", native: "Українська", htmlLang: "uk" },
  { code: "tr", name: "Turkish", native: "Türkçe", htmlLang: "tr" },
  { code: "ar", name: "Arabic", native: "العربية", htmlLang: "ar", rtl: true },
  { code: "hi", name: "Hindi", native: "हिन्दी", htmlLang: "hi" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", htmlLang: "id" },
  { code: "tl", name: "Filipino", native: "Filipino", htmlLang: "fil" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", htmlLang: "vi" },
  { code: "ja", name: "Japanese", native: "日本語", htmlLang: "ja" },
  { code: "ko", name: "Korean", native: "한국어", htmlLang: "ko" },
  { code: "zh", name: "Chinese (Simplified)", native: "简体中文", htmlLang: "zh-Hans" },
  { code: "zt", name: "Chinese (Traditional)", native: "繁體中文", htmlLang: "zh-Hant" },
];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);
/** Stored in preferences.locale.language to mean "work it out from where I am and my device". */
export const AUTO_LANGUAGE = "auto";

export function languageInfo(code: string): LanguageInfo | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

/**
 * The main interface language of each country we have one for (ISO 3166-1 alpha-2). India and the
 * Philippines are left out on purpose: English is the everyday language of apps there, so a guess of
 * Hindi or Filipino would be wrong for most people. Both stay available to pick by hand.
 */
export const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = {
  // Spanish
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", VE: "es", EC: "es", GT: "es", CU: "es",
  BO: "es", DO: "es", HN: "es", PY: "es", SV: "es", NI: "es", CR: "es", PA: "es", UY: "es", GQ: "es",
  // Portuguese
  BR: "pt", PT: "pt", AO: "pt", MZ: "pt", CV: "pt", GW: "pt", ST: "pt", TL: "pt",
  // French
  FR: "fr", MC: "fr", SN: "fr", CI: "fr", ML: "fr", BF: "fr", NE: "fr", TG: "fr", BJ: "fr", GN: "fr",
  CD: "fr", CG: "fr", GA: "fr", CM: "fr", MG: "fr", HT: "fr", LU: "fr",
  // German
  DE: "de", AT: "de", LI: "de", CH: "de",
  IT: "it", SM: "it", VA: "it",
  NL: "nl", BE: "nl", SR: "nl",
  SE: "sv",
  PL: "pl",
  RO: "ro", MD: "ro",
  RU: "ru", BY: "ru", KZ: "ru", KG: "ru",
  UA: "uk",
  TR: "tr",
  // Arabic
  SA: "ar", EG: "ar", AE: "ar", IQ: "ar", JO: "ar", KW: "ar", LB: "ar", LY: "ar", MA: "ar", DZ: "ar",
  TN: "ar", OM: "ar", QA: "ar", BH: "ar", SY: "ar", YE: "ar", SD: "ar", PS: "ar",
  ID: "id",
  VN: "vi",
  JP: "ja",
  KR: "ko",
  CN: "zh", SG: "zh",
  TW: "zt", HK: "zt", MO: "zt",
};

/**
 * The language an "auto" person gets. The device's own language wins when it is one we have and is
 * not English, because a phone set to French in Germany belongs to a French speaker; otherwise the
 * country they are connecting from decides; otherwise English.
 */
export function pickAutoLanguage(country: string | null | undefined, deviceLanguages: readonly string[]): string {
  for (const tag of deviceLanguages) {
    const code = languageFromTag(tag);
    if (code && code !== "en") return code;
    if (code === "en") break;
  }
  const fromCountry = country ? COUNTRY_LANGUAGE[country.toUpperCase()] : undefined;
  return fromCountry ?? "en";
}

/** "pt-BR" -> "pt", "zh-TW"/"zh-Hant" -> "zt", "fil" -> "tl"; null when we have no such language. */
export function languageFromTag(tag: string): string | null {
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  if (lower.startsWith("zh")) return /hant|tw|hk|mo/.test(lower) ? "zt" : "zh";
  if (lower.startsWith("fil")) return "tl";
  const base = lower.split(/[-_]/)[0];
  return LANGUAGE_CODES.includes(base) ? base : null;
}
