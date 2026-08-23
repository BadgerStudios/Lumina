import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Clapperboard, Compass, CornerDownLeft, MessageSquare, Search, Sparkles, Store, Users } from "lucide-react";
import { APP_HOME } from "../../lib/platform";
import { useServers } from "../../queries/servers";
import { useChannels } from "../../queries/channels";
import { useDMs } from "../../queries/dms";
import { useAuthStore } from "../../store/authStore";
import { useUIStore } from "../../store/uiStore";
import { UserAvatar } from "../common/UserAvatar";
import { cn } from "../../lib/cn";

type Entry = {
  id: string;
  label: string;
  hint: string;
  to: string;
  icon?: typeof Search;
  avatar?: { url: string | null; name: string };
};

/**
 * Jump to anything — Ctrl/Cmd-K.
 *
 * The old app had no way to get somewhere by naming it. You navigated by recognising an
 * unlabelled icon and then reading a list, which is fine with three communities and unusable with
 * thirty. This is the keyboard path the deck's outline is the mouse path for.
 *
 * Scope note: rooms are listed for the space you are currently in, plus every space and every
 * conversation. Listing the rooms of *every* space would mean a channels query per space on every
 * keystroke of the first render; the deck expands a space in one click, and that space's rooms are
 * then here.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.commandOpen);
  const setOpen = useUIStore((s) => s.setCommandOpen);
  const navigate = useNavigate();
  const { serverId } = useParams<{ serverId?: string }>();
  const { data: servers } = useServers();
  const { data: channels } = useChannels(serverId);
  const { data: conversations } = useDMs();
  const user = useAuthStore((s) => s.user);
  // Same adult predicate the deck uses — offering a jump target that answers with an error page is
  // worse than not offering it.
  const isConfirmedAdult = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the palette opened, so closing it puts the caret back where the user
  // left it rather than at the top of the document.
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // Global shortcut. Registered here rather than in AppShell so the component that owns the state
  // owns the way in as well; `preventDefault` stops the browser's own find-in-page binding.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUIStore.getState().commandOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      restoreFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setCursor(0);
      return;
    }
    const previous = restoreFocusTo.current;
    restoreFocusTo.current = null;
    // Only if focus is still nowhere useful — if something else deliberately took it (a route
    // change moving focus, say) stealing it back would be worse than leaving it.
    if (previous?.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
      previous.focus();
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [
      { id: "d:messages", label: "Messages", hint: "Go", to: APP_HOME, icon: MessageSquare },
      { id: "d:friends", label: "Friends", hint: "Go", to: "/friends", icon: Users },
      ...(isConfirmedAdult
        ? [
            { id: "d:foryou", label: "For You", hint: "Go", to: "/foryou", icon: Clapperboard },
            { id: "d:discover", label: "Discover", hint: "Go", to: "/discover", icon: Compass },
            { id: "d:studio", label: "Studio", hint: "Go", to: "/studio", icon: Sparkles },
            { id: "d:store", label: "Store", hint: "Go", to: "/store", icon: Store },
          ]
        : []),
    ];

    for (const c of channels ?? []) {
      if (c.type === "CATEGORY" || !serverId) continue;
      out.push({
        id: `c:${c.id}`,
        label: c.name,
        hint: c.type === "VOICE" ? "Voice room" : "Room",
        to: `/channels/${serverId}/${c.id}`,
      });
    }

    for (const s of servers ?? []) {
      out.push({
        id: `s:${s.id}`,
        label: s.name,
        hint: "Space",
        to: `/channels/${s.id}/_`,
        avatar: { url: s.iconUrl, name: s.name },
      });
    }

    for (const c of conversations ?? []) {
      const other = c.participants.find((p) => p.id !== user?.id) ?? c.participants[0];
      const label = c.isGroup
        ? (c.name ?? c.participants.map((p) => p.displayName ?? p.username).join(", "))
        : (other?.displayName ?? other?.username ?? "Unknown");
      out.push({
        id: `m:${c.id}`,
        label,
        hint: c.isGroup ? "Group" : "Conversation",
        to: `/dm/${c.id}`,
        avatar: { url: other?.avatarUrl ?? null, name: label },
      });
    }
    return out;
  }, [servers, channels, conversations, serverId, user?.id, isConfirmedAdult]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 12);
    return entries
      .map((e) => {
        const label = e.label.toLowerCase();
        // Rank by where the match lands: a name that starts with what you typed is almost always
        // the one you meant, and without this "general" loses to "general-announcements" whenever
        // the latter happens to be earlier in the list.
        const index = label.indexOf(q);
        if (index === -1) return null;
        return { entry: e, score: index === 0 ? 0 : 1, index };
      })
      .filter((r): r is { entry: Entry; score: number; index: number } => r !== null)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, 12)
      .map((r) => r.entry);
  }, [entries, query]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  function choose(entry: Entry | undefined) {
    if (!entry) return;
    setOpen(false);
    navigate(entry.to);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to"
      onKeyDown={(e) => {
        // Contain focus. Without this, Tab walks out of an "aria-modal" dialog and into the tab
        // bar and page behind the scrim — reachable by keyboard and screen reader while the
        // palette claims to be exclusive.
        if (e.key === "Tab") e.preventDefault();
      }}
    >
      <div className="lx-scrim absolute inset-0" onClick={() => setOpen(false)} />
      <div className="lx-raised relative flex w-full max-w-lg flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
          <Search size={16} className="shrink-0 text-signal-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => (results.length ? (c + 1) % results.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[cursor]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder="Jump to a space, room or conversation…"
            aria-label="Jump to a space, room or conversation"
            role="combobox"
            aria-expanded="true"
            aria-controls="lx-palette-list"
            aria-activedescendant={results[cursor] ? `lx-palette-${results[cursor].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm text-signal outline-none placeholder:text-signal-faint"
          />
          <kbd className="shrink-0 rounded border border-hairline px-1 font-mono text-[9px] text-signal-faint">esc</kbd>
        </div>

        <div id="lx-palette-list" role="listbox" ref={listRef} className="max-h-[min(24rem,50vh)] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-signal-faint">Nothing matches “{query}”.</p>
          ) : (
            results.map((e, i) => {
              const Icon = e.icon;
              return (
                <button
                  key={e.id}
                  id={`lx-palette-${e.id}`}
                  role="option"
                  aria-selected={i === cursor}
                  // Not a tab stop: the arrow keys move the selection and focus stays in the
                  // input, which is what makes the single-focusable-element containment above
                  // correct rather than a cage.
                  tabIndex={-1}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(e)}
                  data-active={i === cursor}
                  className={cn("lx-row text-sm")}
                >
                  {e.avatar ? (
                    <UserAvatar avatarUrl={e.avatar.url} name={e.avatar.name} size={20} />
                  ) : Icon ? (
                    <Icon size={15} className="shrink-0" />
                  ) : (
                    <span className="lx-mark" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-signal-faint">{e.hint}</span>
                  {i === cursor && <CornerDownLeft size={12} className="shrink-0 text-signal-faint" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
