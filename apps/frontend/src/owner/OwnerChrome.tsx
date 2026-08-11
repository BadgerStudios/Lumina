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
        //
        // `bottom-0` alone clipped the curve against the tile's rounded corner — a rising line ran
        // off the bottom edge mid-stroke and looked like a rendering fault rather than a trend.
        // Insetting it and leaving headroom means the whole shape is inside the panel.
        <div className="pointer-events-none absolute inset-x-2 bottom-1.5 h-7 opacity-45">{trend}</div>
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

      {/* Freshness, pinned right. A dashboard with no timestamp is one you cannot trust after
          leaving it open: every number could be from thirty seconds ago or from this morning, and
          nothing on screen says which. The pulse only shows during an actual fetch. */}
      <span className="ml-auto flex items-center gap-2 text-xs text-signal-faint">
        {updating ? (
          <span className="oc-live" aria-live="polite">updating…</span>
        ) : (
          <span aria-live="polite">
            as of {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </span>
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

/**
 * A badge — role, ban scope, status.
 *
 * Bordered rather than filled. A filled pill at this size reads as a button and gets clicked; the
 * console has real buttons sitting right beside these, and the two must not look alike.
 */
export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "master" | "owner" | "staff" | "good" | "bad";
}) {
  return (
    <span className="oc-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * One row in a list.
 *
 * Every list in the console previously built its own `divide-y` stack, so the Users list, the bans
 * list and the reports list each had different row heights and put the same kinds of control in
 * different places. This fixes the geometry in one place:
 *
 *  - `leading` is a fixed-width slot (avatar, icon), so text starts at the same x on every row and
 *    the column reads as a column.
 *  - `actions` is pinned right and never wraps, so the Ban button is in the same place on row 1 and
 *    row 400 — muscle memory is the entire point of a list you use daily.
 *  - The body is `min-w-0`, which is what actually lets long usernames truncate instead of pushing
 *    the actions off-screen. Without it flex children refuse to shrink below their content.
 */
export function DataRow({
  leading,
  title,
  subtitle,
  meta,
  actions,
  onClick,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="oc-row">
      {leading && <div className="shrink-0">{leading}</div>}

      <div className="min-w-0 flex-1">
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            className="block max-w-full truncate text-left text-sm text-signal hover:underline"
          >
            {title}
          </button>
        ) : (
          <div className="truncate text-sm text-signal">{title}</div>
        )}
        {subtitle && <div className="truncate text-xs text-signal-faint">{subtitle}</div>}
      </div>

      {/* Hidden below `sm`, on purpose: secondary metadata is the first thing worth dropping when
          space runs out, and keeping it forces either a third line or a truncated name. */}
      {meta && <div className="hidden shrink-0 text-xs text-signal-faint sm:block">{meta}</div>}

      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Wraps a set of DataRows. */
export function DataList({ children }: { children: ReactNode }) {
  return <div className="oc-rows">{children}</div>;
}

/**
 * The empty state.
 *
 * Says what would be here and, where there is one, what to do about it. "No users found" alone
 * leaves someone wondering whether the filter is wrong or the data failed to load — which are very
 * different problems with the same blank screen.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="oc-panel flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p className="text-sm text-signal-dim">{title}</p>
      {hint && <p className="max-w-sm text-xs text-signal-faint">{hint}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

/** The sticky search/filter strip above a list. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="oc-toolbar">{children}</div>;
}
