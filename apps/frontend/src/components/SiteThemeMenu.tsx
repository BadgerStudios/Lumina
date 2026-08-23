import { useEffect, useRef, useState } from "react";
import { Check, Moon, Palette, Sun } from "lucide-react";
import { useUIStore, THEMES, LIGHT_THEMES, THEME_META } from "../store/uiStore";

/**
 * A self-contained theme picker for the PUBLIC, pre-auth surfaces (landing page, features page,
 * sign-in, register). The in-app Appearance settings live behind a modal that only exists once a
 * user is logged in — a stranger on the marketing site had no way to change the palette at all, so
 * whatever the pre-paint bootstrap chose was final for them.
 *
 * It drives the exact same `useUIStore.setTheme`, which persists to localStorage and sets
 * `data-theme` on <html> — so a choice made here on the landing page carries straight into the app
 * after sign-in, and vice versa. This is the "offer the same theme" half of the change that made
 * the site default to soft dark instead of flash-banging first-time visitors with white.
 *
 * No portal / z-index gymnastics: it's a plain relative dropdown, closed on outside-click and Esc.
 */
export function SiteThemeMenu({ className = "" }: { className?: string }) {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change theme"
        title="Change theme"
        className="flex items-center gap-1.5 rounded-full border border-hairline bg-base-800/70 px-3 py-1.5 text-sm text-signal-dim transition hover:border-accent hover:text-signal"
      >
        <Palette className="h-4 w-4" />
        <span className="hidden sm:inline">Theme</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-hairline bg-base-800 p-1.5 shadow-2xl"
        >
          {THEMES.map((t) => {
            const meta = THEME_META[t];
            const active = theme === t;
            return (
              <button
                key={t}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(t);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${
                  active ? "bg-base-700" : "hover:bg-base-700/60"
                }`}
              >
                {/* Live swatch built from the theme's own surface colours, so the choice is made by
                    looking rather than by guessing what "carbon" means — same idea as the in-app
                    Appearance grid, just laid out as a compact row. */}
                <span
                  className="flex h-6 w-9 shrink-0 overflow-hidden rounded border border-hairline"
                  style={{ background: meta.bg }}
                >
                  <span className="w-1/3" style={{ background: meta.panel }} />
                  <span className="w-1/3" style={{ background: meta.raised }} />
                  <span
                    className="my-auto ml-auto mr-1 h-1.5 w-1.5 rounded-full"
                    style={{ background: meta.accent }}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-sm font-medium text-signal">
                    {LIGHT_THEMES.includes(t) ? <Sun size={12} /> : <Moon size={12} />}
                    {meta.label}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-signal-faint">
                    {meta.note}
                  </span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
