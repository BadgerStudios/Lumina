// Theme bootstrap, applied before first paint so there's no flash of the wrong theme: same
// precedence as store/uiStore.ts (stored preference wins, otherwise the OS preference) — that
// module re-applies the same value once the bundle loads.
//
// An EXTERNAL file loaded by a parser-blocking <script src> in <head>, not an inline script:
// the production CSP is script-src 'self' with no inline allowance (csp.conf's own doctrine —
// "the fix is to stop inlining"), and the previous inline version of this was silently blocked
// by that policy on every page load, meaning it never ran at all. Found by the platform debug
// sweep reading browser console output; same-origin + <head> placement keeps the
// before-first-paint guarantee.
(function () {
  try {
    var stored = localStorage.getItem("lumina-theme");
    // Kept in sync with THEMES in store/uiStore.ts. Listing them here matters: anything not
    // recognised falls back to the OS preference, so a stored "midnight" that this script
    // didn't know about would flash the default dark palette before the bundle corrected it.
    var known = ["dark", "light", "midnight", "carbon", "moss", "parchment", "slate"];
    // No prefers-color-scheme fallback: a first-time visitor on a light-mode OS used to get the
    // white palette on the public pages — a "flash bang" before they'd chosen anything. Everyone
    // with no saved choice now gets the soft dark default; light is one click away in the theme
    // menu. Must stay in sync with readStoredTheme() in store/uiStore.ts.
    var theme = stored && known.indexOf(stored) !== -1 ? stored : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  try {
    var accent = localStorage.getItem("lumina-accent-theme");
    if (accent) document.documentElement.setAttribute("data-accent", accent);
  } catch (e) {
    /* default accent (no attribute) */
  }
})();
