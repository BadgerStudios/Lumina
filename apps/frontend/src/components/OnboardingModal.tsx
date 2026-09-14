import { useState } from "react";
import { Check, Loader2, ScrollText } from "lucide-react";
import { useOnboardingState, useCompleteOnboarding } from "../queries/onboarding";
import { cn } from "../lib/cn";

/**
 * The first five minutes.
 *
 * Shown once, when a member arrives in a server that has onboarding switched on. It is deliberately
 * not a wizard: one screen, everything visible, and the button at the bottom always works. An
 * orientation that can trap someone is a worse first impression than no orientation at all — so
 * every prompt is optional and skipping lands you in the server anyway. The only thing that can
 * hold you here is rules the server has actually made mandatory.
 *
 * What makes this worth having is not the welcome text. It is that picking two options grants
 * roles, and roles make a hundred-channel server look like the six channels you came for.
 */
export function OnboardingModal({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { data } = useOnboardingState(serverId);
  const complete = useCompleteOnboarding(serverId);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [accepted, setAccepted] = useState(false);

  if (!data?.due) return null;
  const { config } = data;

  const toggle = (promptId: string, optionId: string, multiple: boolean) => {
    setPicked((prev) => {
      const current = prev[promptId] ?? [];
      if (current.includes(optionId)) {
        return { ...prev, [promptId]: current.filter((id) => id !== optionId) };
      }
      // A single-choice prompt replaces rather than accumulates — otherwise the second tap looks
      // like it did nothing while quietly granting both roles.
      return { ...prev, [promptId]: multiple ? [...current, optionId] : [optionId] };
    });
  };

  const blocked = config.requireRules && !accepted;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-base-900/95 backdrop-blur-sm">
      <div
        className="mx-auto w-full max-w-lg px-5 pb-10"
        style={{ paddingTop: "calc(2.5rem + var(--safe-top))" }}
      >
        <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-signal-faint">
          You're in
        </p>
        <h1 className="mt-1 font-display text-2xl leading-tight text-signal">
          {config.welcomeTitle || serverName}
        </h1>
        {config.welcomeBody && (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-signal-dim">
            {config.welcomeBody}
          </p>
        )}

        {config.rules && (
          <section className="mt-6 rounded-xl border border-hairline bg-base-800 p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase text-signal-dim">
              <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
              {config.requireRules ? "Read these first" : "House rules"}
            </h2>
            <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-signal-dim">
              {config.rules}
            </p>
            {config.requireRules && (
              <label className="mt-3 flex items-center gap-2 text-sm text-signal">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                I've read and agree to these
              </label>
            )}
          </section>
        )}

        {config.prompts.map((prompt) => (
          <section key={prompt.id} className="mt-6">
            <h2 className="text-sm font-medium text-signal">{prompt.title}</h2>
            <p className="mb-2 text-xs text-signal-faint">
              {prompt.multiple ? "Pick any that fit" : "Pick one"} — optional, and you can change it later.
            </p>
            <div className="grid gap-2">
              {prompt.options.map((option) => {
                const on = (picked[prompt.id] ?? []).includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggle(prompt.id, option.id, prompt.multiple)}
                    aria-pressed={on}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                      on
                        ? "border-accent bg-accent/10"
                        : "border-hairline bg-base-800 hover:border-signal-faint",
                    )}
                  >
                    {option.emoji && <span className="shrink-0 text-lg">{option.emoji}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-signal">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-xs text-signal-faint">
                          {option.description}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-accent bg-accent text-white" : "border-signal-faint",
                      )}
                    >
                      {on && <Check className="h-3 w-3" aria-hidden="true" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        <button
          type="button"
          disabled={blocked || complete.isPending}
          onClick={() =>
            complete.mutate({
              optionIds: Object.values(picked).flat(),
              acceptedRules: accepted,
            })
          }
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {complete.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Setting you up…
            </>
          ) : (
            "Take me in"
          )}
        </button>
        {blocked && (
          <p className="mt-2 text-center text-xs text-signal-faint">
            Agree to the rules above to continue.
          </p>
        )}
      </div>
    </div>
  );
}
