import { useState } from "react";
import { Monitor, Smartphone, Palette } from "lucide-react";
import { CONCEPTS } from "./concepts";
import { MockApp } from "./MockApp";
import { Group } from "../OwnerChrome";
import { cn } from "../../lib/cn";

type Viewport = "desktop" | "phone";

/**
 * Design lab — full UI redesign concepts, rendered live rather than shown as flat images.
 *
 * A screenshot of a design can hide whether it actually works: whether the type scale survives a
 * long channel name, whether the density is real, whether it holds up at phone width. These are the
 * real components at real sizes, so what you approve is what gets built.
 *
 * Marked temporary in the UI on purpose — this tab is for choosing a direction, and should be
 * removed once one is chosen rather than quietly becoming a permanent feature.
 */
export function DesignLab() {
  const [active, setActive] = useState(CONCEPTS[0].key);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const concept = CONCEPTS.find((c) => c.key === active) ?? CONCEPTS[0];

  return (
    <div className="space-y-5">
      <div className="oc-panel oc-panel-lift flex items-start gap-3 p-4">
        <Palette className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--oc-master)" }} />
        <div>
          <p className="text-sm text-signal">Three directions for the app's redesign.</p>
          <p className="mt-1 text-xs text-signal-dim">
            These are live renders, not mockups — the same components at the same sizes the real app
            uses. Pick one and it becomes the app's design system; nothing here is live for users yet.
          </p>
        </div>
      </div>

      {/* Concept switcher */}
      <div className="flex flex-wrap gap-2">
        {CONCEPTS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActive(c.key)}
            className={cn(
              "oc-panel px-3 py-2 text-left transition",
              active === c.key ? "border-[var(--accent)]" : "hover:border-[var(--oc-line-bright)]",
            )}
          >
            <span className="flex items-center gap-2">
              {/* Palette swatch, so the concepts are distinguishable before you click one. */}
              <span className="flex gap-0.5">
                {[c.tokens.bg, c.tokens.surface, c.tokens.accent, c.tokens.accent2].map((col) => (
                  <span key={col} className="h-4 w-2 rounded-sm" style={{ background: col }} />
                ))}
              </span>
              <span className="text-sm font-medium text-signal">{c.name}</span>
            </span>
            <span className="mt-0.5 block text-xs text-signal-faint">{c.tagline}</span>
          </button>
        ))}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setViewport("desktop")}
            aria-label="Desktop preview"
            className={cn("oc-panel p-2", viewport === "desktop" && "border-[var(--accent)]")}
          >
            <Monitor className="h-4 w-4 text-signal" />
          </button>
          <button
            type="button"
            onClick={() => setViewport("phone")}
            aria-label="Phone preview"
            className={cn("oc-panel p-2", viewport === "phone" && "border-[var(--accent)]")}
          >
            <Smartphone className="h-4 w-4 text-signal" />
          </button>
        </div>
      </div>

      <Group label={`${concept.name} — preview`}>
        <div
          className="oc-panel overflow-hidden"
          style={{ padding: viewport === "phone" ? "1.5rem" : 0 }}
        >
          <div
            className={cn("mx-auto overflow-hidden", viewport === "phone" && "rounded-[28px] border-8 border-black")}
            style={{
              width: viewport === "phone" ? 380 : "100%",
              height: viewport === "phone" ? 760 : 560,
            }}
          >
            {/* `compact` drops the member column at phone width, matching how the real app behaves
                below its breakpoint rather than just scaling the desktop layout down. */}
            <MockApp concept={concept} compact={viewport === "phone"} />
          </div>
        </div>
      </Group>

      <Group label="The argument">
        <div className="oc-panel space-y-3 p-4">
          <div>
            <p className="oc-label mb-1">Why this layout</p>
            <p className="text-sm leading-relaxed text-signal-dim">{concept.rationale}</p>
          </div>
          <div>
            <p className="oc-label mb-1">What it costs</p>
            <p className="text-sm leading-relaxed text-signal-dim">{concept.tradeoff}</p>
          </div>
        </div>
      </Group>

      <Group label="Palette">
        <div className="oc-panel grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          {(
            [
              ["Background", concept.tokens.bg],
              ["Surface", concept.tokens.surface],
              ["Raised", concept.tokens.surfaceAlt],
              ["Line", concept.tokens.line],
              ["Accent", concept.tokens.accent],
              ["Secondary", concept.tokens.accent2],
              ["Good", concept.tokens.good],
              ["Bad", concept.tokens.bad],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className="h-8 w-8 shrink-0 rounded-lg border border-[var(--oc-line)]"
                style={{ background: value }}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs text-signal">{label}</span>
                <span className="oc-num block truncate text-[10px] text-signal-faint">{value}</span>
              </span>
            </div>
          ))}
        </div>
      </Group>
    </div>
  );
}
