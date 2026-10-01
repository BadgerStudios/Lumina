import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Loader2, ShieldAlert, Info, AlertTriangle, Ban, Check } from "lucide-react";
import type { BlockReason, BlockSeverity } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { UserAvatar } from "../components/common/UserAvatar";
import { Group } from "./OwnerChrome";
import { FlagProvenance } from "./OwnerProvenance";
import { useConfirm } from "../components/common/ConfirmDialog";
import { reportError } from "../store/toastStore";
import { useAuthStore } from "../store/authStore";
import { isOwner } from "../lib/platformRole";
import { cn } from "../lib/cn";

interface FlagRow {
  id: string;
  reasonCode: string;
  severity: string;
  detail: string | null;
  active: boolean;
  createdAt: string;
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  hasDevice: boolean;
  hasIp: boolean;
}

/** Codes whose flags keep plaintext sign-up provenance (backend flags/service.ts AGE_PROVENANCE_CODES). */
const AGE_PROVENANCE_CODES = new Set(["AGE_UNDER_MINIMUM", "AGE_MISMATCH", "AGE_SIGNUP_COOLDOWN"]);

const SEVERITY_META: Record<BlockSeverity, { icon: typeof Info; className: string; label: string }> = {
  INFO: { icon: Info, className: "text-signal-faint", label: "Info" },
  RESTRICTED: { icon: AlertTriangle, className: "text-amber", label: "Restricted" },
  SOFT_BLOCK: { icon: ShieldAlert, className: "text-amber", label: "Soft block" },
  HARD_BLOCK: { icon: Ban, className: "text-flare", label: "Hard block" },
};

/**
 * The block-reason catalogue and the flags actually recorded against it.
 *
 * Two halves on purpose: the catalogue is what CAN happen (and what the person was told), the flags
 * are what DID happen. Support needs both — someone quotes a code, you look up what it means and
 * then how often it's been firing.
 */
export function OwnerReasonsPanel({ initialCode }: { initialCode?: string } = {}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialCode ?? null);
  const queryClient = useQueryClient();

  const { data: catalogue, isLoading } = useQuery({
    queryKey: ["master", "reasons", query],
    queryFn: () => api.get<{ reasons: BlockReason[] }>(`/master/reasons?q=${encodeURIComponent(query)}`),
  });

  const { data: flagData } = useQuery({
    queryKey: ["master", "flags", selected],
    queryFn: () =>
      api.get<{ flags: FlagRow[]; counts: Record<string, number>; openCounts?: Record<string, number> }>(
        `/master/flags${selected ? `?code=${encodeURIComponent(selected)}` : ""}`,
      ),
  });

  // Both refresh the owner namespace too: the attention list counts open flags, and a resolve that
  // left "14 age mismatches" on the overview would read as though it hadn't worked.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["master", "flags"] });
    void queryClient.invalidateQueries({ queryKey: ["owner"], predicate: (q) => q.queryKey[1] !== "provenance" });
  };
  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/master/flags/${id}/resolve`, {}),
    onSuccess: refresh,
    onError: (e) => reportError(e, "Couldn't resolve that flag"),
  });
  const resolveAll = useMutation({
    mutationFn: (code: string) => api.post<{ resolved: number }>(`/master/flags/resolve-code`, { code }),
    onSuccess: refresh,
    onError: (e) => reportError(e, "Couldn't resolve those flags"),
  });
  const { confirm } = useConfirm();
  const owner = isOwner(useAuthStore((s) => s.user?.platformRole));

  // Opened from an attention item: bring that reason into view rather than leaving it somewhere
  // down a list of a hundred.
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (initialCode && !scrolled.current && selectedRef.current) {
      scrolled.current = true;
      selectedRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });

  const counts = flagData?.counts ?? {};
  const openCounts = flagData?.openCounts ?? {};

  return (
    <div className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-signal-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reasons — code, wording, category…"
          className="oc-panel w-full py-2 pl-9 pr-3 text-sm text-signal placeholder:text-signal-faint focus:border-[var(--accent)] focus:outline-none"
        />
      </div>

      <Group label={`Catalogue${catalogue ? ` — ${catalogue.reasons.length}` : ""}`}>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : (
          <div className="space-y-2">
            {catalogue?.reasons.map((r) => {
              const meta = SEVERITY_META[r.severity];
              const Icon = meta.icon;
              const open = selected === r.code;
              const fired = counts[r.code] ?? 0;
              return (
                <div key={r.code} ref={open ? selectedRef : undefined} className="oc-panel oc-panel-lift overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setSelected(open ? null : r.code)}
                    className="flex w-full items-start gap-3 p-3 text-left"
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.className)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="oc-num text-xs text-signal-faint">{r.code}</span>
                        <span className="text-sm text-signal">{r.title}</span>
                        <span className={cn("text-[10px] uppercase tracking-wide", meta.className)}>
                          {meta.label}
                        </span>
                      </span>
                      {/* What the affected person actually sees — the thing support most often
                          needs to read back to them verbatim. */}
                      {r.userMessage && (
                        <span className="mt-1 block text-xs text-signal-dim">"{r.userMessage}"</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="oc-num block text-sm text-signal">{fired}</span>
                      <span className="block text-[10px] text-signal-faint">fired</span>
                      {(openCounts[r.code] ?? 0) > 0 && (
                        <span className="block text-[10px] text-amber">{openCounts[r.code]} open</span>
                      )}
                    </span>
                  </button>

                  {open && (
                    <div className="space-y-3 border-t border-[var(--oc-line)] p-3">
                      <div>
                        <p className="oc-label mb-1">Internal note</p>
                        <p className="text-xs leading-relaxed text-signal-dim">{r.staffNote}</p>
                      </div>
                      <p className="text-xs text-signal-faint">
                        {r.selfResolvable
                          ? "The user can clear this themselves."
                          : "Needs support to lift."}
                      </p>

                      <div>
                        <div className="mb-1.5 flex items-center gap-2">
                          <p className="oc-label">Recent occurrences</p>
                          {owner && (openCounts[r.code] ?? 0) > 1 && (
                            <button
                              type="button"
                              disabled={resolveAll.isPending}
                              onClick={async () => {
                                const n = openCounts[r.code] ?? 0;
                                if (
                                  await confirm({
                                    title: `Resolve all ${n} open ${r.code} flags?`,
                                    description:
                                      "Marks every open one resolved. Where a flag is what enforces a block (a sign-up cooldown), resolving it lifts the block.",
                                    confirmText: "Resolve all",
                                  })
                                )
                                  resolveAll.mutate(r.code);
                              }}
                              className="ml-auto rounded px-2 py-0.5 text-[11px] text-signal-faint ring-1 ring-hairline hover:text-signal disabled:opacity-50"
                            >
                              Resolve all {openCounts[r.code]}
                            </button>
                          )}
                        </div>
                        {!flagData || flagData.flags.length === 0 ? (
                          <p className="text-xs text-signal-faint">None recorded.</p>
                        ) : (
                          <div className="space-y-1">
                            {flagData.flags.slice(0, 50).map((f) => (
                              <div key={f.id} className="space-y-1 rounded-lg bg-[var(--oc-bg)] px-2 py-1.5">
                              <div className="flex items-center gap-2">
                                {f.user ? (
                                  <UserAvatar
                                    avatarUrl={f.user.avatarUrl}
                                    name={f.user.displayName ?? f.user.username}
                                    size={22}
                                  />
                                ) : (
                                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-base-600 text-[9px] text-signal-faint">
                                    ?
                                  </span>
                                )}
                                <span className="min-w-0 flex-1 truncate text-xs text-signal-dim">
                                  {f.user ? `@${f.user.username}` : "no account"}
                                  {f.detail ? ` · ${f.detail}` : ""}
                                </span>
                                {/* Presence only — the hashes exist for matching, and rendering
                                    them would turn a screenshot into a data leak. */}
                                {f.hasDevice && (
                                  <span className="shrink-0 text-[9px] uppercase text-signal-faint">device</span>
                                )}
                                {f.hasIp && (
                                  <span className="shrink-0 text-[9px] uppercase text-signal-faint">ip</span>
                                )}
                                <span className="shrink-0 text-[10px] text-signal-faint">
                                  {new Date(f.createdAt).toLocaleDateString()}
                                </span>
                                {f.active ? (
                                  <button
                                    type="button"
                                    disabled={resolve.isPending}
                                    onClick={() => resolve.mutate(f.id)}
                                    title="Mark resolved"
                                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-signal-faint ring-1 ring-hairline hover:text-pulse disabled:opacity-50"
                                  >
                                    <Check className="h-3 w-3" /> Resolve
                                  </button>
                                ) : (
                                  <span className="shrink-0 text-[10px] text-signal-faint">resolved</span>
                                )}
                              </div>
                              {(f.hasIp || f.hasDevice) && AGE_PROVENANCE_CODES.has(f.reasonCode) && <FlagProvenance flagId={f.id} />}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {catalogue?.reasons.length === 0 && (
              <p className="oc-panel p-4 text-sm text-signal-dim">No reason matches "{query}".</p>
            )}
          </div>
        )}
      </Group>
    </div>
  );
}
