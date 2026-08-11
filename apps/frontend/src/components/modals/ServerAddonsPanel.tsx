import { useState } from "react";
import { Puzzle, Search, Trash2, Loader2, AlertTriangle } from "lucide-react";
import {
  useAddonDirectory,
  useServerAddons,
  useInstallAddon,
  useSetAddonEnabled,
  useUninstallAddon,
  type AddonInstall,
} from "../../queries/addons";

/**
 * The Addons tab of server settings.
 *
 * The manifest is shown in full before and after installing, in plain language. That is the whole
 * bargain of a declarative addon system: because an addon can only say things from a fixed
 * vocabulary, everything it will ever do can be listed on one screen — which is not true of a
 * plugin that ships code, and is the reason this was built declarative in the first place.
 */
export function ServerAddonsPanel({ serverId }: { serverId: string }) {
  const [query, setQuery] = useState("");
  const installs = useServerAddons(serverId);
  const directory = useAddonDirectory(query);
  const install = useInstallAddon(serverId);

  const installedSlugs = new Set((installs.data ?? []).map((i) => i.addon.slug));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-bold uppercase text-signal-dim">Installed</h3>
        <p className="mt-1 text-xs text-signal-faint">
          Addons are automations, not code — everything one can do is listed below it.
        </p>

        {installs.isLoading ? (
          <div className="mt-3 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : (installs.data ?? []).length === 0 ? (
          <p className="mt-3 rounded-lg border border-hairline bg-base-900 p-3 text-sm text-signal-dim">
            Nothing installed yet. Pick one from the directory below.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {installs.data!.map((i) => (
              <InstalledAddon key={i.id} serverId={serverId} install={i} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-bold uppercase text-signal-dim">Directory</h3>
        <label className="mt-2 flex items-center gap-2 rounded bg-base-900 px-3 py-2 ring-1 ring-base-500 focus-within:ring-2 focus-within:ring-accent">
          <Search className="h-4 w-4 shrink-0 text-signal-faint" />
          <input
            aria-label="Search addons"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search published addons"
            className="min-w-0 flex-1 bg-transparent text-sm text-signal outline-none placeholder:text-signal-faint"
          />
        </label>

        <div className="mt-2 flex flex-col gap-2">
          {(directory.data ?? []).length === 0 && !directory.isLoading && (
            <p className="rounded-lg border border-hairline bg-base-900 p-3 text-sm text-signal-dim">
              Nothing published yet. Anyone with a developer application can publish one with the{" "}
              <code className="rounded bg-base-800 px-1 py-0.5 text-xs">lumina-addons</code> CLI.
            </p>
          )}
          {(directory.data ?? []).map((a) => (
            <div key={a.id} className="flex items-start gap-3 rounded-lg border border-hairline bg-base-900 p-3">
              <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-signal">{a.name}</span>
                  <span className="shrink-0 text-xs text-signal-faint">v{a.version}</span>
                </div>
                {a.description && <p className="mt-0.5 text-xs text-signal-dim">{a.description}</p>}
                {/* Said before the click, not after: installing an addon that replies also adds
                    its bot to the server, and that is a membership change someone should agree to
                    knowingly. */}
                <p className="mt-0.5 text-[11px] text-signal-faint">
                  Installing adds its automations here, and its bot if it replies to messages.
                </p>
              </div>
              <button
                type="button"
                disabled={installedSlugs.has(a.slug) || install.isPending}
                onClick={() => install.mutate(a.slug)}
                className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {installedSlugs.has(a.slug) ? "Installed" : "Install"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InstalledAddon({ serverId, install }: { serverId: string; install: AddonInstall }) {
  const setEnabled = useSetAddonEnabled(serverId);
  const uninstall = useUninstallAddon(serverId);

  return (
    <div className="rounded-lg border border-hairline bg-base-900 p-3">
      <div className="flex items-start gap-3">
        <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-signal">{install.addon.name}</span>
            <span className="shrink-0 text-xs text-signal-faint">v{install.addon.version}</span>
          </div>
          {install.addon.description && (
            <p className="mt-0.5 text-xs text-signal-dim">{install.addon.description}</p>
          )}
        </div>

        <label className="flex shrink-0 items-center gap-1.5 text-xs text-signal-dim">
          <input
            type="checkbox"
            checked={install.enabled}
            disabled={setEnabled.isPending}
            onChange={(e) => setEnabled.mutate({ installId: install.id, enabled: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
          {install.enabled ? "On" : "Off"}
        </label>
        <button
          type="button"
          onClick={() => uninstall.mutate(install.id)}
          disabled={uninstall.isPending}
          aria-label={`Remove ${install.addon.name}`}
          className="shrink-0 rounded p-1 text-signal-faint hover:text-dnd disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Said out loud rather than silently degrading: an addon whose replies can't run should
          explain why, not just appear to do nothing. */}
      {install.needsBot && !install.botUser && (
        <p className="mt-2 flex items-center gap-1.5 rounded bg-amber/10 px-2 py-1 text-xs text-amber">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          This addon replies to messages, but its application has no bot — those actions will be skipped.
        </p>
      )}

      <ul className="mt-2 flex flex-col gap-1 border-t border-hairline pt-2">
        {install.addon.manifest.automations.map((a, i) => (
          <li key={i} className="text-xs text-signal-dim">
            <span className="text-signal">{a.name}</span> — when a message {describeWhen(a.when)}, then{" "}
            {a.then.map(describeAction).join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Turns the manifest's condition object back into a sentence. The point is that an admin can read
 * what they are agreeing to without knowing the manifest format. */
function describeWhen(when: Record<string, unknown>): string {
  const parts: string[] = [];
  const contains = when.contains as string[] | undefined;
  const startsWith = when.startsWith as string[] | undefined;
  const inChannels = when.inChannels as string[] | undefined;

  if (contains?.length) parts.push(`mentions ${contains.map((k) => `“${k}”`).join(" or ")}`);
  if (startsWith?.length) parts.push(`starts with ${startsWith.map((k) => `“${k}”`).join(" or ")}`);
  if (typeof when.minLength === "number") parts.push(`is at least ${when.minLength} characters`);
  if (typeof when.maxLength === "number") parts.push(`is at most ${when.maxLength} characters`);
  if (inChannels?.length) parts.push(`is in ${inChannels.map((c) => `#${c}`).join(" or ")}`);

  return parts.length > 0 ? parts.join(" and ") : "arrives";
}

function describeAction(action: { type: string; emoji?: string; text?: string }): string {
  switch (action.type) {
    case "react":
      return `react with ${action.emoji}`;
    case "pin":
      return "pin it";
    case "delete":
      return "delete it";
    case "reply":
      return `reply “${(action.text ?? "").slice(0, 60)}”`;
    default:
      return action.type;
  }
}
