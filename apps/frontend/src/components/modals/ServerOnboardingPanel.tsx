import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, GripVertical } from "lucide-react";
import { useOnboardingConfig, useSaveOnboarding, type SaveOnboardingInput } from "../../queries/onboarding";
import { useRoles } from "../../queries/roles";
import { cn } from "../../lib/cn";

/**
 * Configuring what a new member sees.
 *
 * The whole configuration is edited as one form and saved in one go, which is why the server
 * replaces it wholesale rather than reconciling per-prompt edits — an editor that autosaves each
 * keystroke into a list of ordered children is a great deal of machinery for a screen someone opens
 * twice a year.
 *
 * The roles attached to an option are the point of the feature, so they are picked here directly
 * rather than hidden behind a second screen.
 */

type DraftOption = { label: string; description: string; emoji: string; roleIds: string[] };
type DraftPrompt = { title: string; multiple: boolean; options: DraftOption[] };

const emptyOption = (): DraftOption => ({ label: "", description: "", emoji: "", roleIds: [] });
const emptyPrompt = (): DraftPrompt => ({ title: "", multiple: false, options: [emptyOption()] });

export function ServerOnboardingPanel({ serverId }: { serverId: string }) {
  const { data, isLoading } = useOnboardingConfig(serverId);
  const { data: roles } = useRoles(serverId);
  const save = useSaveOnboarding(serverId);

  const [enabled, setEnabled] = useState(false);
  const [welcomeTitle, setWelcomeTitle] = useState("");
  const [welcomeBody, setWelcomeBody] = useState("");
  const [rules, setRules] = useState("");
  const [requireRules, setRequireRules] = useState(false);
  const [prompts, setPrompts] = useState<DraftPrompt[]>([]);

  // Seeded from the server once it arrives. Keyed on the fetch rather than run on mount, because
  // the query resolves after the first render and a mount-only effect would leave the form empty.
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setWelcomeTitle(data.welcomeTitle ?? "");
    setWelcomeBody(data.welcomeBody ?? "");
    setRules(data.rules ?? "");
    setRequireRules(data.requireRules);
    setPrompts(
      data.prompts.map((p) => ({
        title: p.title,
        multiple: p.multiple,
        options: p.options.map((o) => ({
          label: o.label,
          description: o.description ?? "",
          emoji: o.emoji ?? "",
          roleIds: o.roleIds,
        })),
      })),
    );
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      </div>
    );
  }

  const mutate = (fn: (draft: DraftPrompt[]) => DraftPrompt[]) => setPrompts((p) => fn([...p]));

  const payload: SaveOnboardingInput = {
    enabled,
    welcomeTitle: welcomeTitle.trim() || null,
    welcomeBody: welcomeBody.trim() || null,
    rules: rules.trim() || null,
    requireRules,
    prompts: prompts
      // A prompt with no title, or with no usable options, is a half-finished row someone left
      // behind — dropped on save rather than rejected, so the form never refuses to submit.
      .filter((p) => p.title.trim() && p.options.some((o) => o.label.trim()))
      .map((p) => ({
        title: p.title.trim(),
        multiple: p.multiple,
        options: p.options
          .filter((o) => o.label.trim())
          .map((o) => ({
            label: o.label.trim(),
            description: o.description.trim() || null,
            emoji: o.emoji.trim() || null,
            roleIds: o.roleIds,
          })),
      })),
  };

  const rulesMissing = requireRules && !rules.trim();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label className="flex items-center gap-2 text-sm text-signal">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Show new members a welcome screen
        </label>
        <p className="mt-1 text-xs text-signal-faint">
          Members answer a couple of questions when they arrive, and the answers give them roles —
          which is what makes a big server feel like the part of it they came for.
        </p>
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Welcome</span>
        <input
          value={welcomeTitle}
          onChange={(e) => setWelcomeTitle(e.target.value.slice(0, 120))}
          placeholder="Headline — defaults to the server name"
          className="mt-1 w-full rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
        />
        <textarea
          value={welcomeBody}
          onChange={(e) => setWelcomeBody(e.target.value.slice(0, 1000))}
          rows={3}
          placeholder="A sentence or two about what this place is for."
          className="mt-2 w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Rules</span>
        <textarea
          value={rules}
          onChange={(e) => setRules(e.target.value.slice(0, 4000))}
          rows={4}
          placeholder="Optional. Shown on the welcome screen."
          className="mt-1 w-full rounded-lg border border-hairline bg-base-700 p-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
        />
        <label className="mt-2 flex items-center gap-2 text-sm text-signal">
          <input
            type="checkbox"
            checked={requireRules}
            onChange={(e) => setRequireRules(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Members must accept before they can post
        </label>
        {rulesMissing && (
          <p className="mt-1 text-xs text-flare">Write some rules first, or nobody will be able to post.</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase text-signal-dim">Questions</span>
          <button
            type="button"
            onClick={() => mutate((p) => [...p, emptyPrompt()])}
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add a question
          </button>
        </div>

        {prompts.length === 0 && (
          <p className="mt-2 text-xs text-signal-faint">
            No questions yet. Even one — "what are you here for?" — is what turns the channel list
            into something a newcomer can read.
          </p>
        )}

        <div className="mt-2 space-y-3">
          {prompts.map((prompt, pi) => (
            <div key={pi} className="rounded-xl border border-hairline bg-base-800 p-3">
              <div className="flex items-center gap-2">
                <GripVertical className="h-4 w-4 shrink-0 text-signal-faint" aria-hidden="true" />
                <input
                  value={prompt.title}
                  onChange={(e) =>
                    mutate((p) => {
                      p[pi] = { ...p[pi], title: e.target.value.slice(0, 120) };
                      return p;
                    })
                  }
                  placeholder="What are you here for?"
                  className="min-w-0 flex-1 rounded-lg border border-hairline bg-base-700 px-2 py-1.5 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => mutate((p) => p.filter((_, i) => i !== pi))}
                  aria-label="Remove this question"
                  className="shrink-0 text-signal-faint hover:text-flare"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <label className="mt-2 flex items-center gap-2 text-xs text-signal-dim">
                <input
                  type="checkbox"
                  checked={prompt.multiple}
                  onChange={(e) =>
                    mutate((p) => {
                      p[pi] = { ...p[pi], multiple: e.target.checked };
                      return p;
                    })
                  }
                  className="h-3.5 w-3.5 accent-accent"
                />
                Let them pick more than one
              </label>

              <div className="mt-2 space-y-2">
                {prompt.options.map((option, oi) => (
                  <div key={oi} className="rounded-lg border border-hairline bg-base-900 p-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={option.emoji}
                        onChange={(e) =>
                          mutate((p) => {
                            const opts = [...p[pi].options];
                            opts[oi] = { ...opts[oi], emoji: e.target.value.slice(0, 16) };
                            p[pi] = { ...p[pi], options: opts };
                            return p;
                          })
                        }
                        placeholder="🙂"
                        aria-label="Emoji"
                        className="w-12 shrink-0 rounded border border-hairline bg-base-700 px-1.5 py-1 text-center text-sm"
                      />
                      <input
                        value={option.label}
                        onChange={(e) =>
                          mutate((p) => {
                            const opts = [...p[pi].options];
                            opts[oi] = { ...opts[oi], label: e.target.value.slice(0, 80) };
                            p[pi] = { ...p[pi], options: opts };
                            return p;
                          })
                        }
                        placeholder="Answer"
                        className="min-w-0 flex-1 rounded border border-hairline bg-base-700 px-2 py-1 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          mutate((p) => {
                            p[pi] = { ...p[pi], options: p[pi].options.filter((_, i) => i !== oi) };
                            return p;
                          })
                        }
                        aria-label="Remove this answer"
                        className="shrink-0 text-signal-faint hover:text-flare"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    {/* The roles are the whole point of the option, so they sit with it rather than
                        behind another click. */}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(roles ?? [])
                        .filter((r) => r.name !== "@everyone")
                        .map((role) => {
                          const on = option.roleIds.includes(role.id);
                          return (
                            <button
                              key={role.id}
                              type="button"
                              onClick={() =>
                                mutate((p) => {
                                  const opts = [...p[pi].options];
                                  const ids = on
                                    ? opts[oi].roleIds.filter((id) => id !== role.id)
                                    : [...opts[oi].roleIds, role.id];
                                  opts[oi] = { ...opts[oi], roleIds: ids };
                                  p[pi] = { ...p[pi], options: opts };
                                  return p;
                                })
                              }
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[0.65rem]",
                                on
                                  ? "border-accent bg-accent/20 text-accent"
                                  : "border-hairline text-signal-faint hover:text-signal",
                              )}
                            >
                              {role.name}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    mutate((p) => {
                      p[pi] = { ...p[pi], options: [...p[pi].options, emptyOption()] };
                      return p;
                    })
                  }
                  className="text-xs text-accent hover:underline"
                >
                  Add an answer
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {save.isError && <p className="text-sm text-flare">{(save.error as Error).message}</p>}

      <button
        type="button"
        disabled={save.isPending || rulesMissing}
        onClick={() => save.mutate(payload)}
        className="self-start rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
      >
        {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : "Save onboarding"}
      </button>
    </div>
  );
}
