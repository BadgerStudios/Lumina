import { useEffect, useState } from "react";
import { AUTO_LANGUAGE, LANGUAGES, languageInfo } from "@lumina/shared";
import { usePreferencesStore } from "../../store/preferencesStore";
import { currentLanguage, onLanguageChange, resolveLanguage } from "../../lib/i18n/language";
import { cn } from "../../lib/cn";

/**
 * The interface language. Everything the app itself says is machine-translated on our own server
 * (see lib/i18n); what people write is always shown as they wrote it.
 */
export function LanguageSection() {
  const choice = usePreferencesStore((s) => s.prefs.locale.language);
  const update = usePreferencesStore((s) => s.update);
  const [showing, setShowing] = useState(currentLanguage());
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => onLanguageChange(setShowing), []);
  useEffect(() => {
    let live = true;
    void resolveLanguage(AUTO_LANGUAGE).then((lang) => live && setDetected(lang));
    return () => {
      live = false;
    };
  }, []);

  const pick = (language: string) => void update({ locale: { language } });
  const detectedInfo = detected ? languageInfo(detected) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-signal-dim">
        Lumina's menus, buttons and messages from the app are translated automatically. What people write — messages, names, posts — always shows exactly as they wrote it.
      </p>
      <div role="radiogroup" aria-label="Language" className="flex flex-col divide-y divide-hairline rounded-lg border border-hairline">
        <Option
          selected={choice === AUTO_LANGUAGE}
          onSelect={() => pick(AUTO_LANGUAGE)}
          title="Automatic"
          detail={detectedInfo ? <>From your device and location: <span translate="no">{detectedInfo.native}</span></> : "From your device and location"}
        />
        {LANGUAGES.map((l) => (
          <Option
            key={l.code}
            selected={choice === l.code}
            onSelect={() => pick(l.code)}
            title={<span translate="no">{l.native}</span>}
            detail={l.native === l.name ? null : <span translate="no">{l.name}</span>}
          />
        ))}
      </div>
      {showing !== "en" && (
        <p className="text-xs leading-relaxed text-signal-dim">
          Machine translation can be clumsy. If something reads wrong, switch to <span translate="no">English</span> here any time.
        </p>
      )}
    </div>
  );
}

function Option({ selected, onSelect, title, detail }: { selected: boolean; onSelect: () => void; title: React.ReactNode; detail: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn("flex items-center justify-between gap-3 px-3 py-2.5 text-left", selected ? "bg-accent/10" : "hover:bg-white/5")}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-signal">{title}</span>
        {detail && <span className="block text-xs text-signal-dim">{detail}</span>}
      </span>
      <span className={cn("h-4 w-4 shrink-0 rounded-full border-2", selected ? "border-accent bg-accent" : "border-hairline")} aria-hidden />
    </button>
  );
}
