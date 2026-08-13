import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { useCreateTemplate, useDeleteTemplate, useMyTemplates } from "../../queries/templates";

/**
 * "Save this server's structure as a template", plus the list of templates you have saved.
 *
 * Shown in server settings rather than a top-level page because that is where someone is when the
 * thought occurs — they have just finished arranging channels and roles.
 */
export function ServerTemplateSection({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { data: templates } = useMyTemplates();
  const create = useCreateTemplate();
  const remove = useDeleteTemplate();
  const [name, setName] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const fromThisServer = (templates ?? []).filter((t) => t.name.length > 0);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 2000);
    } catch {
      // Clipboard access is denied in plenty of legitimate situations (an insecure origin, a
      // WebView without permission). The code is visible on screen either way, so there is nothing
      // to recover from — only a tick that does not appear.
    }
  }

  return (
    <div className="border-t border-hairline pt-4">
      <h3 className="mb-1 text-sm font-semibold text-signal">Templates</h3>
      <p className="mb-3 text-xs leading-relaxed text-signal-dim">
        Saves this server&apos;s channels, categories and roles as a reusable shape. No messages,
        members or invites travel with it, and applied roles arrive without Administrator or Manage
        Server.
      </p>

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${serverName} template`}
          aria-label="Template name"
          className="flex-1 rounded-lg border border-hairline bg-base-900 px-2.5 py-1.5 text-sm text-signal focus:border-accent focus:outline-none"
        />
        <button
          disabled={create.isPending}
          onClick={() =>
            create.mutate({ serverId, name: name.trim() || `${serverName} template` }, { onSuccess: () => setName("") })
          }
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save template"}
        </button>
      </div>

      {fromThisServer.length > 0 ? (
        <div className="mt-3 space-y-1">
          {fromThisServer.map((t) => (
            <div key={t.code} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-base-700/50">
              <span className="min-w-0 flex-1 truncate text-sm text-signal">{t.name}</span>
              <span className="shrink-0 text-[11px] text-signal-faint">
                {t.summary.textChannels + t.summary.voiceChannels} channels · used {t.uses}×
              </span>
              <code className="shrink-0 rounded bg-base-900 px-1.5 py-0.5 font-mono text-[11px] text-signal-dim">
                {t.code}
              </code>
              <button
                onClick={() => void copy(t.code)}
                aria-label={`Copy the code for ${t.name}`}
                className="shrink-0 rounded p-1 text-signal-faint hover:text-signal"
              >
                {copied === t.code ? <Check className="h-3.5 w-3.5 text-online" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => remove.mutate(t.code)}
                aria-label={`Delete template ${t.name}`}
                className="shrink-0 rounded p-1 text-signal-faint hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
