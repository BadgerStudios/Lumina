/**
 * Deterrent against casual inspection of the shipped client.
 *
 * ## Read this before trusting it
 *
 * This does NOT secure anything, and it must never be treated as if it does. A browser runs code it
 * has already downloaded, so the code is, by construction, in the reader's hands. Every one of these
 * paths defeats it in a single step:
 *
 *   - open DevTools *before* navigating here, or dock it and reload
 *   - the browser's own menu (⋮ → More tools → Developer tools) — no keystroke involved
 *   - `view-source:https://…`, or `curl` on the asset URL
 *   - any browser where the user has remapped the shortcut
 *
 * So the honest description of this module is: it stops the accidental F12 and the reflexive
 * right-click → Inspect. That is a real (if small) thing to want on a public product — it keeps
 * ordinary users out of a view that will only confuse them, and it makes casual snooping take
 * deliberate effort. It is not, and cannot be, a protection boundary.
 *
 * **The actual boundary is server-side and unchanged**: every privileged route enforces its own
 * role check (`requireOwner`, `requireSiteAdmin`, per-server permission bitfields). Nothing in the
 * bundle grants access to anything; reading it reveals shapes, not secrets. If a value would be
 * damaging to read, it must not be in the bundle in the first place — that rule is what keeps this
 * module from mattering.
 *
 * ## Why it is production-only
 *
 * `import.meta.env.PROD` is replaced by Vite with a literal at build time, so in a dev build the
 * whole body folds away and DevTools behaves normally. Guarding our own workflow behind the same
 * switch we ship to users would make every debugging session start by deleting this file.
 *
 * ## Why right-click is not blocked everywhere
 *
 * Blanket `contextmenu` suppression is the usual implementation and it is user-hostile in a chat
 * app: it takes away paste, spellcheck corrections, and "copy link address" — the menu people
 * actually open. Editable fields are therefore exempt, which costs nothing (a text input's context
 * menu has no Inspect entry pointing anywhere interesting that F12 wouldn't reach anyway) and keeps
 * the app usable for the overwhelming majority who were never trying to inspect it.
 */

/** Chromium/Firefox/Safari all reach DevTools through some subset of these. */
function isDevToolsChord(e: KeyboardEvent): boolean {
  if (e.key === "F12") return true;

  // Ctrl+Shift+… on Windows/Linux, Cmd+Opt+… on macOS. Both are checked unconditionally rather
  // than sniffing the platform: a Mac keyboard attached to Linux, or Chrome on macOS honouring the
  // Windows chord, would otherwise slip through a platform branch.
  const key = e.key.toLowerCase();
  const ctrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey;
  const cmdAlt = e.metaKey && e.altKey;

  // I = Inspector, J = Console, C = element picker.
  if ((ctrlShift || cmdAlt) && (key === "i" || key === "j" || key === "c")) return true;

  // View source. Deliberately NOT extended to Ctrl+S (save page): that shortcut is muscle memory
  // for far more people than it would ever stop, and the page source is a fetch away regardless.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === "u") return true;

  return false;
}

function isEditable(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
}

export function installInspectGuard(): void {
  if (!import.meta.env.PROD) return;

  // Capture phase on `window`, so this runs before any component-level handler and before the
  // event can be stopped by something upstream. `preventDefault` is what actually suppresses the
  // browser's default action for these chords.
  window.addEventListener(
    "keydown",
    (e) => {
      if (isDevToolsChord(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );

  window.addEventListener(
    "contextmenu",
    (e) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
    },
    { capture: true },
  );
}
