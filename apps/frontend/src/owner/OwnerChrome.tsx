import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type StatusState = "good" | "warn" | "bad" | "idle";

export function StatusDot({ state }: { state: StatusState }) {
  return <span className="oc-dot" data-state={state} aria-hidden />;
}

/**
 * A metric tile.
 *
 * The value is the loudest thing in the tile and the label the quietest — on a dashboard read at a
 * glance, the number has to be findable without reading anything else. `trend` slots a sparkline in
 * behind, so a figure and its shape occupy one tile instead of two.
 */
export function Metric({
  label,
  value,
  sub,
  state,
  trend,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  state?: StatusState;
  trend?: ReactNode;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "oc-panel oc-panel-lift relative flex flex-col gap-1 p-3 text-left",
        onClick && "transition hover:border-[var(--oc-line-bright)]",
      )}
    >
      <div className="flex items-center gap-1.5">
        {state && <StatusDot state={state} />}
        <span className="oc-label truncate">{label}</span>
      </div>
      <span
        className={cn(
          "oc-num font-display text-xl leading-none",
          state === "bad" ? "text-flare" : state === "warn" ? "text-amber" : "text-signal",
        )}
      >
        {value}
      </span>
      {sub && <span className="truncate text-xs text-signal-faint">{sub}</span>}
      {trend && (
        // Behind the text at low opacity: the shape is context for the number, not a competing
        // element, and overlaying it keeps the tile one row tall.
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 opacity-40">{trend}</div>
      )}
    </Tag>
  );
}

/** Groups a set of tiles under a quiet caption. */
export function Group({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="oc-label">{label}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The always-visible condition strip.
 *
 * One line answering "is anything wrong right now", pinned under the header so the answer is never
 * more than a glance away regardless of which section is open — the thing an operator actually
 * opens a console to find out.
 */
export function StatusStrip({
  items,
  updating,
}: {
  items: Array<{ label: string; state: StatusState; detail?: string }>;
  updating?: boolean;
}) {
  const worst: StatusState = items.some((i) => i.state === "bad")
    ? "bad"
    : items.some((i) => i.state === "warn")
      ? "warn"
      : "good";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--oc-line)] bg-[var(--oc-panel)] px-4 py-2">
      <span className="flex items-center gap-1.5">
        <StatusDot state={worst} />
        <span className="text-xs font-medium text-signal">
          {worst === "good" ? "All systems normal" : worst === "warn" ? "Needs attention" : "Problem detected"}
        </span>
      </span>

      <span className="hidden h-3 w-px bg-[var(--oc-line)] sm:block" />

      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <StatusDot state={item.state} />
          <span className="text-xs text-signal-dim">{item.label}</span>
          {item.detail && <span className="oc-num text-xs text-signal-faint">{item.detail}</span>}
        </span>
      ))}

      {updating && (
        <span className="oc-live ml-auto text-xs text-signal-faint" aria-live="polite">
          updating…
        </span>
      )}
    </div>
  );
}

/** A row of things demanding action. Severity drives colour so the eye lands on the worst first. */
export function ActionRow({
  label,
  state,
  onClick,
}: {
  label: string;
  state: StatusState;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="oc-panel oc-panel-lift flex w-full items-center gap-3 px-4 py-3 text-left transition hover:border-[var(--oc-line-bright)]"
    >
      <StatusDot state={state} />
      <span className="flex-1 text-sm text-signal">{label}</span>
      <span className="text-xs text-signal-faint">Open →</span>
    </button>
  );
}
