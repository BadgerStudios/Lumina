// One shared relative-time source of truth. Before this, HomeRoute / ForumView / ActivityFeed /
// OwnerActivityPanel each rolled their own with different wording, suffixes, rounding, and
// fallbacks ("5m" vs "5m ago", floor vs round, no date fallback). Use these everywhere.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function secondsSince(iso: string | number | Date | null | undefined): number | null {
  if (iso == null) return null;
  const then = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 1000));
}

/** A short calendar date, e.g. "Mar 4" (this year) or "Mar 4, 2024" (older). */
export function shortDate(iso: string | number | Date | null | undefined): string {
  if (iso == null) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full, localized timestamp for tooltips/hovers, e.g. "Mar 4, 2025, 3:41 PM". */
export function absoluteTime(iso: string | number | Date | null | undefined): string {
  if (iso == null) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact form with no suffix: "now", "5m", "3h", "2d", then a short date past a week. */
export function relativeTimeShort(iso: string | number | Date | null | undefined): string {
  const s = secondsSince(iso);
  if (s == null) return "";
  if (s < 45) return "now";
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h`;
  if (s < WEEK) return `${Math.floor(s / DAY)}d`;
  return shortDate(iso);
}

/** Long form with suffix: "just now", "5m ago", "3h ago", "2d ago", then a short date past a week. */
export function relativeTime(iso: string | number | Date | null | undefined): string {
  const s = secondsSince(iso);
  if (s == null) return "";
  if (s < 45) return "just now";
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m ago`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h ago`;
  if (s < WEEK) return `${Math.floor(s / DAY)}d ago`;
  return shortDate(iso);
}
