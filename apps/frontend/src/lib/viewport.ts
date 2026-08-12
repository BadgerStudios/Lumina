/**
 * Viewport detection — one source of truth for "how much room do we actually have".
 *
 * ## Why this exists at all
 *
 * The layout was sized in `100vh` and switched between mobile and desktop purely on WIDTH. Both
 * assumptions break on a real phone:
 *
 * 1. `100vh` on mobile is the viewport with the browser's URL bar *collapsed*. While it is showing
 *    — which is most of the time — the page is taller than the screen, so the bottom of the app is
 *    below the fold. On a shell that is `overflow-hidden` there is no way to scroll to it: the
 *    bottom nav and the composer are simply gone.
 * 2. A width-only breakpoint means rotating a phone to landscape (844×390) crosses 768px and the
 *    app switches to the three-column desktop layout — on a viewport 390 pixels tall. Sidebars,
 *    header, member list and composer stacked into less vertical room than a portrait phone has.
 *
 * So "fits any screen" needs two things CSS breakpoints alone don't give: a height that tracks the
 * real visible area, and a compact/roomy decision that considers BOTH dimensions.
 *
 * ## What gets published
 *
 * `startViewportSync()` writes to `<html>` and everything else reads from there:
 *
 * | Property            | Meaning |
 * |---------------------|---------|
 * | `--app-height`      | usable height in px — what layout roots should use instead of `100vh` |
 * | `--app-width`       | usable width in px |
 * | `--keyboard-inset`  | px hidden behind the on-screen keyboard, 0 when it's closed |
 * | `data-orientation`  | `portrait` / `landscape` |
 * | `data-viewport`     | `compact` / `roomy` — the same split the `md:` breakpoint uses |
 *
 * The data attributes are there so a stylesheet can react without JavaScript re-rendering anything,
 * and so a screenshot or a bug report shows which mode the app thought it was in.
 */

/**
 * The compact/roomy split, as a media query.
 *
 * This string MUST stay in lockstep with `screens.md` in tailwind.config.ts — they are the same
 * decision expressed twice, once for JS and once for CSS, and if they disagree a component will
 * hide its mobile drawer button while the sidebar it replaces is still hidden by CSS.
 */
export const COMPACT_QUERY = "(max-width: 767.98px), (max-height: 499.98px)";

export type Orientation = "portrait" | "landscape";

export interface ViewportState {
  width: number;
  height: number;
  orientation: Orientation;
  /** Too narrow OR too short for the multi-column layout. */
  isCompact: boolean;
  /** A touch/stylus primary input — drives hit-target sizing, not layout. */
  isTouch: boolean;
  /** Pixels currently hidden behind an on-screen keyboard. */
  keyboardInset: number;
}

const SSR_STATE: ViewportState = {
  width: 1280,
  height: 800,
  orientation: "landscape",
  isCompact: false,
  isTouch: false,
  keyboardInset: 0,
};

/**
 * Anything smaller is browser chrome settling, not a keyboard.
 *
 * The visual viewport shrinks by a few pixels for all sorts of reasons — a URL bar animating, an
 * iOS accessory bar, momentum scroll overshoot. Treating those as "the keyboard is open" makes the
 * composer jump around while someone is reading.
 */
const KEYBOARD_MIN_PX = 80;

function measure(): ViewportState {
  if (typeof window === "undefined") return SSR_STATE;

  const vv = window.visualViewport;
  const width = window.innerWidth;
  const height = window.innerHeight;

  // On iOS the layout viewport does NOT shrink when the keyboard opens — only the visual viewport
  // does — so this difference is the only signal available. On Android the WebView usually resizes
  // the layout viewport instead, which makes the difference ~0 and the padding correctly unneeded.
  const rawInset = vv ? height - vv.height - vv.offsetTop : 0;
  const keyboardInset = rawInset >= KEYBOARD_MIN_PX ? Math.round(rawInset) : 0;

  return {
    width,
    height,
    orientation: height >= width ? "portrait" : "landscape",
    isCompact: window.matchMedia?.(COMPACT_QUERY).matches ?? width < 768,
    isTouch: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    keyboardInset,
  };
}

let current: ViewportState = measure();
const listeners = new Set<() => void>();

function sameState(a: ViewportState, b: ViewportState): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.isCompact === b.isCompact &&
    a.isTouch === b.isTouch &&
    a.keyboardInset === b.keyboardInset
  );
}

function publish(state: ViewportState) {
  const root = document.documentElement;
  // Explicit pixels rather than leaving CSS on `100dvh`. dvh is close, but it is defined as the
  // viewport with browser chrome RETRACTED, so it is still too tall while the URL bar is showing,
  // and it does not move at all for the keyboard. The stylesheet keeps `100dvh` as the pre-JS
  // fallback; these values override it once measured.
  root.style.setProperty("--app-height", `${state.height}px`);
  root.style.setProperty("--app-width", `${state.width}px`);
  root.style.setProperty("--keyboard-inset", `${state.keyboardInset}px`);
  root.dataset.orientation = state.orientation;
  root.dataset.viewport = state.isCompact ? "compact" : "roomy";
}

function refresh() {
  const next = measure();
  if (sameState(current, next)) return;
  current = next;
  publish(next);
  for (const listener of listeners) listener();
}

let stop: (() => void) | null = null;

/**
 * Begins tracking the viewport. Safe to call more than once; the second call is a no-op.
 *
 * Call it before the first render (see main.tsx) so the very first paint already has real values —
 * otherwise the app lays out at `100dvh`, then snaps a frame later.
 */
export function startViewportSync(): () => void {
  if (typeof window === "undefined" || stop) return () => undefined;

  publish(current);

  const onChange = () => refresh();
  window.addEventListener("resize", onChange);
  // Fires on rotate before `resize` settles on some Android WebViews, and is the only event that
  // fires at all on desktop Safari when a window is moved between displays of different scale.
  window.addEventListener("orientationchange", onChange);
  window.visualViewport?.addEventListener("resize", onChange);
  window.visualViewport?.addEventListener("scroll", onChange);

  // A rotation is reported by the OS before the browser has finished relaying out, so the first
  // measurement after `orientationchange` can still be the OLD dimensions. Re-measuring shortly
  // after catches that without polling forever.
  const settle = window.setTimeout(refresh, 250);

  stop = () => {
    window.clearTimeout(settle);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
    window.visualViewport?.removeEventListener("resize", onChange);
    window.visualViewport?.removeEventListener("scroll", onChange);
    stop = null;
  };
  return stop;
}

/** Subscribe/snapshot pair for `useSyncExternalStore` — see hooks/useViewport.ts. */
export function subscribeViewport(listener: () => void): () => void {
  listeners.add(listener);
  // Components can mount before main.tsx's call in tests and in the owner bundle; starting here
  // too means a consumer is never left reading a snapshot that nothing updates.
  startViewportSync();
  return () => {
    listeners.delete(listener);
  };
}

export function getViewport(): ViewportState {
  return current;
}

export function getServerViewport(): ViewportState {
  return SSR_STATE;
}
