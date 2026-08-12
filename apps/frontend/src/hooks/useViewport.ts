import { useSyncExternalStore } from "react";
import {
  getServerViewport,
  getViewport,
  subscribeViewport,
  type Orientation,
  type ViewportState,
} from "../lib/viewport";

/**
 * The current viewport, re-rendering the caller when it changes.
 *
 * One shared subscription behind `useSyncExternalStore` rather than a `resize` listener per
 * component: a rotation on a page with a dozen viewport-aware components would otherwise run a
 * dozen independent measurements, each forcing its own layout read.
 *
 * Prefer CSS where CSS can do the job — `md:`/`max-md:` already encode the same compact/roomy split
 * (see tailwind.config.ts) and cost no JavaScript. Reach for this hook when the decision genuinely
 * cannot be expressed as a style: choosing a different component tree, sizing a canvas, deciding how
 * many items to fetch.
 */
export function useViewport(): ViewportState {
  return useSyncExternalStore(subscribeViewport, getViewport, getServerViewport);
}

/** `true` when the layout is in its single-column mode — too narrow OR too short for columns. */
export function useIsCompact(): boolean {
  return useViewport().isCompact;
}

export function useOrientation(): Orientation {
  return useViewport().orientation;
}
