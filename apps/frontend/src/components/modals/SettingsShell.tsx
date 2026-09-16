import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Search, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { COMPACT_QUERY } from "../../lib/viewport";

/**
 * The settings surface shared by space settings and user settings.
 *
 * Two layouts from one tree:
 *
 * - Wide: a sidebar (who these settings belong to, a filter box, grouped sections with a one-line
 *   hint each) beside the open section.
 * - Compact (phones, or a landscape phone): a two-screen stack. The first screen IS the sidebar,
 *   full width with labels and hints, and tapping a section slides that section in with a back
 *   button. It replaces a 64px icon rail that showed twelve unlabelled glyphs — on the device
 *   where most owners actually run their space, the navigation had no words on it.
 *
 * Sections are grouped (Space / Community / Integrations) because twelve flat tabs is a list you
 * scan; three groups of four is a map you remember. The filter box exists for the same reason.
 */

export interface SettingsItem<K extends string> {
  key: K;
  label: string;
  icon: LucideIcon;
  /** One short line: what lives here. Shown under the label; searchable. */
  hint?: string;
}

export interface SettingsGroup<K extends string> {
  title: string;
  items: SettingsItem<K>[];
}

interface SettingsShellProps<K extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Screen-reader dialog title, e.g. "Lumina Official settings". */
  title: string;
  /** Who the settings belong to — a space or the signed-in account. */
  identity: { name: string; caption: string; imageUrl?: string | null };
  groups: SettingsGroup<K>[];
  active: K;
  onSelect: (key: K) => void;
  /**
   * Compact layout only: open on the list of sections rather than straight into `active`.
   * Deep links (e.g. "open the Bots tab") pass false so they land where they were sent.
   */
  startOnList?: boolean;
  /** Sidebar footer — user settings puts Log out here. */
  footer?: ReactNode;
  /** Classes for the scrolling content column; defaults to the settings padding. */
  contentClassName?: string;
  children: ReactNode;
}

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => (typeof window !== "undefined" ? window.matchMedia(COMPACT_QUERY).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

const SAFE_AREA_STYLE = {
  paddingTop: "var(--safe-top)",
  paddingBottom: "var(--safe-bottom)",
  paddingLeft: "max(env(safe-area-inset-left), var(--android-safe-left, 0px))",
  paddingRight: "max(env(safe-area-inset-right), var(--android-safe-right, 0px))",
} as const;

export function SettingsShell<K extends string>({
  open,
  onOpenChange,
  title,
  identity,
  groups,
  active,
  onSelect,
  startOnList = true,
  footer,
  contentClassName,
  children,
}: SettingsShellProps<K>) {
  const compact = useCompact();
  const [query, setQuery] = useState("");
  // Compact only: which of the two screens is showing. Reset on every open so a previous visit
  // (possibly to a different space) never decides where this one lands.
  const [showList, setShowList] = useState(startOnList);
  useEffect(() => {
    if (open) {
      setShowList(startOnList);
      setQuery("");
    }
  }, [open, startOnList]);

  const activeItem = useMemo(() => groups.flatMap((g) => g.items).find((i) => i.key === active), [groups, active]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q)) }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const select = (key: K) => {
    onSelect(key);
    if (compact) setShowList(false);
  };

  const listPane = (
    <nav
      aria-label="Settings sections"
      className={cn(
        "flex shrink-0 flex-col bg-base-800",
        compact ? "w-full" : "w-72 border-r border-base-900/60",
      )}
    >
      {/* Who these settings belong to. On a phone this doubles as the first screen's header. */}
      <div className="flex items-center gap-3 border-b border-base-900/60 px-4 py-3">
        {identity.imageUrl ? (
          <img src={identity.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-base-600 text-base font-semibold text-signal">
            {identity.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-signal">{identity.name}</div>
          <div className="truncate text-xs text-signal-faint">{identity.caption}</div>
        </div>
        {compact && (
          <Dialog.Close asChild>
            <button className="shrink-0 rounded-lg p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal" aria-label="Close settings">
              <X size={20} />
            </button>
          </Dialog.Close>
        )}
      </div>

      <label className="relative mx-3 mt-3 block">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-signal-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a setting"
          aria-label="Find a setting"
          className="w-full rounded-lg bg-base-900 py-2 pl-9 pr-3 text-sm text-signal placeholder:text-signal-faint outline-none ring-1 ring-transparent focus:ring-accent"
        />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {visibleGroups.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-signal-faint">Nothing matches “{query.trim()}”.</p>
        )}
        {visibleGroups.map((group) => (
          <div key={group.title} className="mb-4 last:mb-0">
            <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-signal-faint">{group.title}</div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = !compact && item.key === active;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => select(item.key)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-lg px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      compact ? "py-3" : "py-2",
                      isActive ? "bg-base-500 text-signal" : "text-signal-dim hover:bg-base-700 hover:text-signal",
                    )}
                  >
                    {isActive && <span aria-hidden className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent" />}
                    <item.icon size={18} className={cn("shrink-0", isActive ? "text-accent" : "")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      {item.hint && <span className="block truncate text-xs text-signal-faint">{item.hint}</span>}
                    </span>
                    {compact && <ChevronRight size={16} className="shrink-0 text-signal-faint" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {footer && <div className="border-t border-base-900/60 p-3">{footer}</div>}
    </nav>
  );

  const contentPane = (
    <div key={active} className={cn("flex min-w-0 flex-1 flex-col bg-base-700", compact && "lm-enter")}>
      <div className="flex shrink-0 items-center gap-2 border-b border-base-900/60 px-3 py-3 md:px-5">
        {compact && (
          <button
            type="button"
            onClick={() => setShowList(true)}
            className="rounded-lg p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal"
            aria-label="Back to all settings"
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-signal md:text-xl">{activeItem?.label}</h1>
        <Dialog.Close asChild>
          <button className="shrink-0 rounded-lg p-1.5 text-signal-dim hover:bg-base-600 hover:text-signal" aria-label="Close settings">
            <X size={22} />
          </button>
        </Dialog.Close>
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain", contentClassName ?? "p-4 md:p-5")}>{children}</div>
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* z-[55]/z-[60]: above the app's mobile bottom nav (fixed z-50). */}
        <Dialog.Overlay className="fixed inset-0 z-[55] bg-black/60" />
        {/* Safe-area padding so nothing sits under the system bars (viewport-fit=cover). */}
        <Dialog.Content className="fixed inset-0 z-[60] flex focus:outline-none" style={SAFE_AREA_STYLE}>
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {compact ? (showList ? listPane : contentPane) : (
            <>
              {listPane}
              {contentPane}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
