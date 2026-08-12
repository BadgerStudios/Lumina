import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Loader2, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../../lib/apiClient";

interface AutoModRule {
  id: string;
  name: string;
  terms: string[];
  wholeWord: boolean;
  enabled: boolean;
  exemptRoleIds: string[];
  createdAt: string;
}

/**
 * AutoMod rules for one server.
 *
 * Terms are edited as a comma-separated line rather than a tag input: a moderator pasting a
 * blocklist has it in exactly that shape already, and a per-term chip UI turns a paste of forty
 * words into forty interactions.
 */
export function ServerAutoModPanel({ serverId }: { serverId: string }) {
  const queryClient = useQueryClient();
  const key = ["automod", serverId];

  const { data: rules, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<AutoModRule[]>(`/servers/${serverId}/automod`),
  });

  const [name, setName] = useState("");
  const [terms, setTerms] = useState("");
  const [wholeWord, setWholeWord] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.post(`/servers/${serverId}/automod`, {
        name: name.trim(),
        terms: terms.split(",").map((t) => t.trim()).filter(Boolean),
        wholeWord,
      }),
    onSuccess: () => {
      setName("");
      setTerms("");
      setWholeWord(false);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const toggle = useMutation({
    mutationFn: (rule: AutoModRule) =>
      api.patch<void>(`/servers/${serverId}/automod/${rule.id}`, { enabled: !rule.enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/servers/${serverId}/automod/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const parsedTerms = terms.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-bold text-signal">AutoMod</h3>
        <p className="mt-1 text-xs text-signal-dim">
          Messages containing a listed term are refused before they are sent — nobody sees them.
          The sender is told which rule stopped them, by name, so make the name something that
          explains itself.
        </p>
      </div>

      {isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      ) : rules && rules.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-hairline bg-base-900 p-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-signal">{rule.name}</span>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-signal-dim">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => toggle.mutate(rule)}
                    className="accent-accent"
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  onClick={() => remove.mutate(rule.id)}
                  aria-label={`Delete ${rule.name}`}
                  className="shrink-0 rounded p-1 text-signal-faint hover:bg-base-700 hover:text-dnd"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <p className="mt-1.5 break-words text-xs text-signal-faint">
                {rule.terms.length} term{rule.terms.length === 1 ? "" : "s"}
                {rule.wholeWord && " · whole words only"}
                {/* The terms themselves are shown to people who can already edit them — there is no
                    secret being kept from a server manager, and a rule you cannot read is one you
                    cannot maintain. */}
                {": "}
                <span className="text-signal-dim">{rule.terms.join(", ")}</span>
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-base-900 p-3">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-signal-faint" />
          <p className="text-xs text-signal-dim">
            No rules yet. Nothing is filtered until you add one.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
        <span className="text-xs font-bold uppercase text-signal-dim">New rule</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name — shown to whoever it blocks"
          className="rounded bg-base-900 px-2.5 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-accent"
        />
        <input
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder="Terms, comma separated"
          className="rounded bg-base-900 px-2.5 py-1.5 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-accent"
        />
        <label className="flex items-center gap-2 text-xs text-signal-dim">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
            className="accent-accent"
          />
          Match whole words only
          {/* Named for the failure it prevents rather than the mechanism, because the mechanism is
              not what an operator is deciding between. */}
          <span className="text-signal-faint">— stops “ass” matching “class”</span>
        </label>

        {create.isError && (
          <p className="text-xs text-dnd">
            {create.error instanceof ApiError ? create.error.message : "Couldn't create that rule"}
          </p>
        )}

        <button
          type="button"
          disabled={!name.trim() || parsedTerms.length === 0 || create.isPending}
          onClick={() => create.mutate()}
          className="flex items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Add rule{parsedTerms.length > 0 && ` (${parsedTerms.length} term${parsedTerms.length === 1 ? "" : "s"})`}
        </button>
      </div>
    </div>
  );
}
