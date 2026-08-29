import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * A segmented one-time-code field.
 *
 * ## Why one input under six boxes
 *
 * The six boxes are presentational. A single real `<input>` sits transparent on top of them, which
 * is what keeps paste, password-manager autofill and the iOS/Android one-time-code keyboard
 * working — all three break on the usual implementation of six separate inputs wired together with
 * focus-shuffling keydown handlers, and they break silently, in exactly the flow where a user has
 * no patience left.
 *
 * ## Why a spring rather than a transition
 *
 * Each box holds a 0-9 strip that slides to the right digit, so the previous number visibly travels
 * away instead of being swapped out. The strip is driven by a damped spring integrated per frame
 * rather than a CSS transition, and the difference only shows when you interrupt it: type quickly
 * and each strip carries its existing velocity into the next target instead of restarting from
 * zero. A CSS transition always restarts, and that restart is what makes fast typing feel
 * mechanical.
 */

const ROWS = 10;

type SpringHandle = {
  to: (target: number) => void;
  set: (value: number) => void;
  stop: () => void;
};

function makeSpring(onFrame: (v: number) => void): SpringHandle {
  const stiffness = 210;
  const damping = 24;
  const precision = 0.002;
  let value = 0;
  let target = 0;
  let velocity = 0;
  let raf = 0;

  const step = () => {
    // Fixed sub-steps rather than the real frame delta: a stiff spring integrated against a long
    // delta (a dropped frame, a backgrounded tab) overshoots to infinity and never settles.
    for (let i = 0; i < 2; i++) {
      const force = -stiffness * (value - target);
      const drag = -damping * velocity;
      velocity += (force + drag) / 120;
      value += velocity / 120;
    }
    onFrame(value);
    if (Math.abs(value - target) > precision || Math.abs(velocity) > precision) {
      raf = requestAnimationFrame(step);
    } else {
      value = target;
      velocity = 0;
      onFrame(value);
      raf = 0;
    }
  };

  return {
    to(next) {
      target = next;
      if (!raf) raf = requestAnimationFrame(step);
    },
    set(next) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      value = target = next;
      velocity = 0;
      onFrame(value);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

export function CodeInput({
  value,
  onChange,
  length = 6,
  state = "idle",
  autoFocus = false,
  label = "Confirmation code",
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  /** `bad` tints the boxes and recoils the digits; `ok` turns them through to the success colour. */
  state?: "idle" | "ok" | "bad";
  autoFocus?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  const boxRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const springs = useRef<SpringHandle[]>([]);

  // Someone who has asked for reduced motion gets the digit placed, not thrown.
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const springFor = useCallback((index: number) => {
    let spring = springs.current[index];
    if (!spring) {
      spring = makeSpring((v) => {
        const el = boxRefs.current[index];
        if (el) el.style.setProperty("--y", `${v}em`);
      });
      springs.current[index] = spring;
    }
    return spring;
  }, []);

  useEffect(() => {
    const held = springs.current;
    return () => held.forEach((s) => s?.stop());
  }, []);

  // Row 0 is blank; digit d lives at row d+1.
  useEffect(() => {
    for (let i = 0; i < length; i++) {
      const digit = value[i];
      const row = digit === undefined ? 0 : Number(digit) + 1;
      const spring = springFor(i);
      if (reduced) spring.set(-row);
      else spring.to(-row);
    }
  }, [value, length, reduced, springFor]);

  // A refusal knocks the digits sideways and lets them settle back, so the field physically
  // reacts rather than only changing colour.
  useEffect(() => {
    if (state !== "bad" || reduced) return;
    for (let i = 0; i < length; i++) {
      const digit = value[i];
      const row = digit === undefined ? 0 : Number(digit) + 1;
      const spring = springFor(i);
      spring.to(-row + 0.2);
      const timer = window.setTimeout(() => spring.to(-row), 90);
      // Only the last timer needs clearing; they all fire within 90ms of each other.
      if (i === length - 1) return () => window.clearTimeout(timer);
    }
  }, [state, value, length, reduced, springFor]);

  return (
    <div className="lm-code-field relative flex gap-2" data-state={state}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, length))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={length}
        aria-label={label}
        // Transparent and on top: the boxes below are decoration, this is the real field.
        // 16px minimum or iOS zooms the page on focus.
        className="lx-focus absolute inset-0 z-10 h-full w-full cursor-pointer rounded-lg border-0 bg-transparent text-[16px] text-transparent caret-transparent outline-none"
      />
      {Array.from({ length }, (_, i) => {
        const filled = value[i] !== undefined;
        const active = !disabled && i === value.length && state !== "ok";
        return (
          <div
            key={i}
            data-filled={filled}
            data-active={active}
            className="lm-code-box relative grid aspect-[3/4] min-w-0 flex-1 place-items-center overflow-hidden rounded-lg bg-base-900"
          >
            <span
              ref={(el) => {
                boxRefs.current[i] = el;
              }}
              className="lm-code-strip flex flex-col items-center font-mono text-2xl leading-none"
            >
              {/* Blank row first, then 0-9. */}
              <i className="grid h-[1em] place-items-center not-italic" />
              {Array.from({ length: ROWS }, (_, d) => (
                <i key={d} className="grid h-[1em] place-items-center not-italic">
                  {d}
                </i>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
