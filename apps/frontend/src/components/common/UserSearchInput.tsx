import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, Loader2, X, Check } from "lucide-react";
import type { UserDTO, ServerDTO } from "@lumina/shared";
import { api, resolveAssetUrl } from "../../lib/apiClient";
import { UserAvatar } from "./UserAvatar";
import { cn } from "../../lib/cn";

export interface LookupUser extends UserDTO {
  isFriend?: boolean;
}

/**
 * Debounce for typeahead queries.
 *
 * Without it every keystroke is a request, and responses land out of order — results for "ali"
 * arriving after results for "alice" makes the list visibly jump backwards. 160ms is short enough to
 * feel immediate while still collapsing a burst of typing into one query.
 */
function useDebounced<T>(value: T, ms = 160): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Wraps the matched portion of a name in a highlight.
 *
 * Without this, a result list for "mi" is a wall of names with no indication of WHY each one
 * matched — which is most of what makes a search feel unresponsive even when the results are right.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [{ text, match: false }];
    const lower = text.toLowerCase();
    const out: Array<{ text: string; match: boolean }> = [];
    let i = 0;
    while (i < text.length) {
      const found = lower.indexOf(q, i);
      if (found === -1) {
        out.push({ text: text.slice(i), match: false });
        break;
      }
      if (found > i) out.push({ text: text.slice(i, found), match: false });
      out.push({ text: text.slice(found, found + q.length), match: true });
      i = found + q.length;
    }
    return out;
  }, [text, query]);

  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

interface UserSearchInputProps {
  onSelect: (user: LookupUser) => void;
  placeholder?: string;
  excludeSelf?: boolean;
  /** Already chosen — shown dimmed with a tick rather than hidden, so it's obvious why someone you
   * just picked is no longer selectable. */
  excludeIds?: string[];
  /** Restricts results to one server's members. */
  serverId?: string;
  friendsOnly?: boolean;
  autoFocus?: boolean;
  limit?: number;
  /** Keeps the query after choosing — right for multi-select pickers. */
  keepQueryOnSelect?: boolean;
}

export function UserSearchInput({
  onSelect,
  placeholder = "Search people…",
  excludeSelf = true,
  excludeIds = [],
  serverId,
  friendsOnly,
  autoFocus,
  limit = 8,
  keepQueryOnSelect = false,
}: UserSearchInputProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const debounced = useDebounced(query);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["lookup", "users", debounced, excludeSelf, serverId, friendsOnly, limit],
    queryFn: () => {
      const params = new URLSearchParams({ q: debounced, limit: String(limit) });
      if (!excludeSelf) params.set("excludeSelf", "false");
      if (serverId) params.set("serverId", serverId);
      if (friendsOnly) params.set("friendsOnly", "true");
      return api.get<{ users: LookupUser[]; suggested: boolean }>(`/lookup/users?${params.toString()}`);
    },
    // Always enabled: an empty query returns suggested contacts, so the list is useful before a
    // single character is typed.
    enabled: open,
    // Holds the previous results while the next request is in flight, so the list doesn't blank
    // out and reflow between keystrokes.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const results = data?.users ?? [];
  const suggested = data?.suggested ?? false;

  useEffect(() => setHighlight(0), [debounced]);

  // Keeps the keyboard-highlighted row in view when arrowing past the visible window.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const choose = (user: LookupUser) => {
    if (excludeIds.includes(user.id)) return;
    onSelect(user);
    if (!keepQueryOnSelect) {
      setQuery("");
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-signal-faint" />
        <input
          aria-label="Search for a person"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => Math.min(h + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && results[highlight]) {
              e.preventDefault();
              choose(results[highlight]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className="w-full rounded-lg border border-hairline bg-base-700 py-2 pl-9 pr-16 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
        />
        <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-signal-faint" />}
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setOpen(true);
              }}
              aria-label="Clear search"
              className="text-signal-faint hover:text-signal"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-hairline bg-base-800 shadow-lg"
        >
          {suggested && results.length > 0 && (
            <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-signal-faint">
              Suggested
            </p>
          )}

          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-signal-faint">
              {isFetching
                ? "Searching…"
                : debounced.trim().length === 0
                  ? "Start typing to search for anyone"
                  : `No one matching "${debounced}"`}
            </p>
          ) : (
            results.map((user, i) => {
              const already = excludeIds.includes(user.id);
              const name = user.displayName ?? user.username;
              return (
                <button
                  key={user.id}
                  type="button"
                  role="option"
                  data-index={i}
                  aria-selected={i === highlight}
                  disabled={already}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(user)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left transition",
                    i === highlight && !already ? "bg-base-600" : "hover:bg-base-700",
                    already && "opacity-50",
                  )}
                >
                  <UserAvatar
                    avatarUrl={user.avatarUrl}
                    name={name}
                    size={32}
                    presence={user.presence}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-signal">
                      <Highlight text={name} query={debounced} />
                    </span>
                    <span className="block truncate text-xs text-signal-faint">
                      @<Highlight text={user.username} query={debounced} />
                    </span>
                  </span>
                  {already ? (
                    <Check className="h-4 w-4 shrink-0 text-pulse" />
                  ) : user.isFriend ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-signal-faint">
                      friend
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Same interaction model, for servers. Scoped server-side to the caller's memberships. */
export function ServerSearchInput({
  onSelect,
  placeholder = "Search your servers…",
}: {
  onSelect: (server: ServerDTO) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const debounced = useDebounced(query);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["lookup", "servers", debounced],
    queryFn: () =>
      api.get<{ servers: ServerDTO[]; suggested: boolean }>(
        `/lookup/servers?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  useEffect(() => setHighlight(0), [debounced]);
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const servers = data?.servers ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-signal-faint" />
        <input
          aria-label="Search for a server"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, servers.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && servers[highlight]) {
              e.preventDefault();
              onSelect(servers[highlight]);
              setQuery("");
              setOpen(false);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          className="w-full rounded-lg border border-hairline bg-base-700 py-2 pl-9 pr-8 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-signal-faint" />
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-hairline bg-base-800 shadow-lg">
          {servers.length === 0 ? (
            <p className="px-3 py-3 text-sm text-signal-faint">
              {isFetching ? "Searching…" : `No server matching "${debounced}"`}
            </p>
          ) : (
            servers.map((server, i) => (
              <button
                key={server.id}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  onSelect(server);
                  setQuery("");
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition",
                  i === highlight ? "bg-base-600" : "hover:bg-base-700",
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-base-600 text-xs font-bold text-signal">
                  {server.iconUrl ? (
                    <img src={resolveAssetUrl(server.iconUrl)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    server.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-signal">
                  <Highlight text={server.name} query={debounced} />
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
