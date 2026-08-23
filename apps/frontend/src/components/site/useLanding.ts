import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Interaction hooks for the cinematic landing page. All of them are decorative-only: every one
 * degrades to "content simply visible / static" — under prefers-reduced-motion, in old browsers,
 * or before hydration — so nothing here can ever hide or break the actual marketing content.
 */

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scroll reveal: returns a ref; when the element first enters the viewport it gets
 * data-revealed="true", which landing.css uses to ease `.reveal` children in. One-shot on
 * purpose — content that vanishes again while scrolling back up reads as flicker, not craft.
 */
export function useReveal<T extends HTMLElement>(threshold = 0.18) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      el.dataset.revealed = "true";
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            io.unobserve(entry.target);
            armAndReveal(entry.target as HTMLElement);
          }
        }
      },
      { threshold, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

/**
 * Runs one group's reveal, holding a compositor layer only while it is actually moving.
 *
 * `will-change` is not a hint that expires — the browser keeps the promoted layer until the
 * declaration goes away. Declaring it statically on `.reveal` therefore promoted all 37 reveals
 * on this page for the entire visit, including the ~29 still below the fold that had not animated
 * yet and the ones that had long since finished. On a page whose main thread is nearly idle while
 * scrolling (~16% busy) and whose whole cost is compositing, that was the largest avoidable layer
 * count on the page.
 *
 * So the class is applied here instead, for the duration of the transition and no longer:
 *   arm (adds will-change) -> next frame, flip data-revealed (starts the transition) -> disarm.
 * The rAF gap matters: set in the same frame as the transform change, the promotion lands too
 * late to buy the transition anything.
 *
 * Timer rather than `transitionend` because the reveals are staggered by an inline
 * `--reveal-delay`, and a transition that never starts (reduced motion, an element already at its
 * resting values, a tab hidden throughout) fires no event at all — this always fires.
 */
function armAndReveal(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>(".reveal")];
  if (root.classList.contains("reveal")) nodes.push(root);
  const REVEAL_MS = 900; // matches the transition duration in landing.css

  for (const n of nodes) n.classList.add("is-arming");
  requestAnimationFrame(() => {
    root.dataset.revealed = "true";
    let longest = 0;
    for (const n of nodes) longest = Math.max(longest, parseFloat(getComputedStyle(n).transitionDelay) * 1000 || 0);
    window.setTimeout(() => {
      for (const n of nodes) n.classList.remove("is-arming");
    }, longest + REVEAL_MS + 200);
  });
}

/**
 * Count-up stat: animates 0 → target over `duration` ms the first time the host element scrolls
 * into view, easing out so the last digits settle gently. Numbers are REAL (they come from
 * /api/site/stats) — the animation only dramatizes the arrival, never the value.
 */
export function useCountUp(target: number | undefined, duration = 1600) {
  const ref = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(0);
  const started = useRef(false);
  const play = useCallback(
    (to: number) => {
      if (prefersReducedMotion()) {
        setValue(to);
        return;
      }
      const t0 = performance.now();
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setValue(Math.round(to * eased));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [duration],
  );

  useEffect(() => {
    const el = ref.current;
    if (typeof target !== "number") return;
    if (!el || !("IntersectionObserver" in window)) {
      setValue(target);
      return;
    }
    if (started.current) {
      // Target refreshed after the animation already ran (stats poll) — snap, don't replay.
      setValue(target);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !started.current) {
          started.current = true;
          play(target);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target, play]);

  return { ref, value };
}

/**
 * Pointer tilt: writes --rx/--ry custom properties (used by .tilt-card's transform) from the
 * pointer's position over the wrapper. Handlers are attached declaratively by spreading the
 * returned props. Touch devices never fire pointerenter+move sequences that matter here, and
 * reduced-motion zeroes the transform in CSS, so no JS gating is needed beyond the cheap write.
 */
export function useTilt(maxDeg = 7) {
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.setProperty("--ry", `${(px * maxDeg * 2).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${(-py * maxDeg * 2).toFixed(2)}deg`);
    },
    [maxDeg],
  );
  // A tilt card only moves while a pointer is over it, so it only needs a compositor layer then.
  // `will-change` used to be declared statically in landing.css, which promoted every card for the
  // whole visit — the same mistake the reveals made, see armAndReveal().
  const onMouseEnter = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.classList.add("is-tilting");
  }, []);
  const onMouseLeave = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    // Held until the card has finished easing back to rest (0.35s in landing.css), not dropped on
    // the way out — releasing mid-transition forces exactly the re-raster the layer was avoiding.
    window.setTimeout(() => el.classList.remove("is-tilting"), 450);
  }, []);
  return { onMouseMove, onMouseEnter, onMouseLeave };
}

/**
 * Cursor spotlight for feature cards: writes --mx/--my so .spotlight-card::after's radial glow
 * follows the pointer.
 */
export function useSpotlight() {
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--my", `${e.clientY - rect.top}px`);
  }, []);
  return { onMouseMove };
}

/**
 * Autoplaying product video that only actually plays while on screen. Browsers already lazy-load
 * with preload="none"; this also pauses when scrolled away so a page full of loops doesn't spin
 * a laptop's fans. Muted+playsInline are set by the caller (required for autoplay policies).
 */
export function useInViewVideo(margin = "160px") {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = entry.target as HTMLVideoElement;
          if (entry.isIntersecting) void video.play().catch(() => undefined);
          else video.pause();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return ref;
}

/**
 * Tracks which section is currently in view, for the fixed section rail. Uses a viewport band
 * centered on the middle of the screen so the "current" section is the one the reader is actually
 * looking at, rather than whichever merely touched the top edge.
 */
export function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best = "";
        let bestRatio = 0;
        for (const [id, ratio] of seen) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = id;
          }
        }
        if (best && bestRatio > 0) setActive(best);
      },
      { rootMargin: "-35% 0px -35% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}
