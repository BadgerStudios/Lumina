import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Loader2, X, Copy } from "lucide-react";
import { api, ApiError } from "../../lib/apiClient";
import { PUBLIC_ORIGIN } from "../../lib/platform";

interface Step {
  at: string;
  key: string;
  label: string;
  detail?: string;
  ok: boolean;
}

interface Recipe {
  id: string;
  sourceKey: string;
  sourceUrl?: string;
  displayName: string;
  runtime: string | null;
  installCmd: string | null;
  startCmd: string | null;
  tokenEnvVar: string | null;
  notes: string | null;
  installCount: number;
  verified: boolean;
}

interface InstallRequest {
  id: string;
  sourceUrl: string;
  status: "QUEUED" | "RESOLVING" | "PREPARING" | "READY" | "RUNNING" | "FAILED";
  progress: number;
  phase: string | null;
  steps: Step[];
  applicationId: string | null;
  applicationName: string | null;
  applicationExists: boolean;
  error: string | null;
  createdAt: string;
  recipe: Recipe | null;
}

interface ServerBot {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
}

const IN_FLIGHT = new Set(["QUEUED", "RESOLVING", "PREPARING"]);

/**
 * Hidden 2026-08-22 (owner's call) while "add a bot" only paid off for bots you could host
 * yourself. Opened again 2026-09-16: Lumina now runs bots on its own host (HOSTED_BOTS below),
 * so the page has something that works with one tap. The notice component stays for the record.
 */
const UNDER_DEVELOPMENT = false;

/**
 * Bots Lumina runs itself, on the bot host — nothing for a space owner to install or keep
 * online. Curated by hand: these are the applications' ids on this instance, and each one has
 * been seen answering in Lumina Official. Permissions are the standard bot grant.
 */
const HOSTED_BOTS: Array<{ clientId: string; name: string; blurb: string }> = [
  { clientId: "cmu37utv6001dmo01jynwvmdv", name: "Red", blurb: "General-purpose: moderation, fun, utilities. Commands start with ! (try !ping)." },
  { clientId: "cmu37uu1a001pmo01rmkl559a", name: "Nadeko", blurb: "Games, currency and utilities. Commands start with . (try .ping)." },
  { clientId: "cmu39sd170009qr01hhk0j9sk", name: "Ree6", blurb: "Levelling, welcome messages and moderation. Slash commands (try /ping)." },
];
const HOSTED_BOT_PERMISSIONS = "491519";

function HostedBots({ serverId, present }: { serverId: string; present: Set<string> }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (clientId: string) =>
      api.post<{ alreadyPresent: boolean }>("/oauth2/authorize", { clientId, scope: "bot", permissions: HOSTED_BOT_PERMISSIONS, guildId: serverId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["serverBots", serverId] }),
  });
  return (
    <section>
      <h3 className="mb-1 font-semibold text-signal">Hosted by Lumina</h3>
      <p className="mb-2 text-sm text-signal-dim">
        These run on Lumina's own bot host. Nothing to set up: add one and it is in your space within a few seconds.
      </p>
      <div className="space-y-1">
        {HOSTED_BOTS.map((b) => {
          const here = present.has(b.name.toLowerCase());
          return (
            <div key={b.clientId} className="flex items-start gap-2 rounded bg-base-900 px-3 py-2">
              <Bot size={15} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-signal">{b.name}</p>
                <p className="text-xs text-signal-faint">{b.blurb}</p>
              </div>
              {here ? (
                <span className="shrink-0 py-1 text-xs text-online">In this space</span>
              ) : (
                <button
                  type="button"
                  disabled={add.isPending}
                  onClick={() => add.mutate(b.clientId)}
                  className="shrink-0 rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-60"
                >
                  Add to this space
                </button>
              )}
            </div>
          );
        })}
      </div>
      {add.isError && (
        <p className="mt-2 text-sm text-dnd">{add.error instanceof ApiError ? add.error.message : "Could not add that bot"}</p>
      )}
    </section>
  );
}

/**
 * Bot onboarding for one server.
 *
 * The point of showing the worker's steps rather than a spinner: the interesting case is not
 * success, it is "that link identifies a bot but doesn't contain it" — which needs the admin to
 * do something, and is only actionable if they can see where the worker got to.
 */
export function ServerBotsPanel({ serverId }: { serverId: string }) {
  if (UNDER_DEVELOPMENT) return <BotsUnderDevelopment />;
  return <ServerBotsPanelInner serverId={serverId} />;
}

function BotsUnderDevelopment() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-base-600 bg-base-900 p-5">
        <div className="mb-2 flex items-center gap-2">
          <Bot size={17} className="text-accent" />
          <h3 className="font-semibold text-signal">Bots</h3>
          <span className="rounded-full bg-base-700 px-2 py-0.5 text-[11px] uppercase tracking-wide text-signal-dim">
            Under development
          </span>
        </div>
        <p className="text-sm text-signal-dim">
          Adding bots is being built and is turned off for now. It will appear here when it does
          the whole job rather than part of it.
        </p>
      </div>

      <div className="rounded-lg bg-base-900 p-4 text-sm">
        <p className="mb-2 font-semibold text-signal">Where it has got to</p>
        <ul className="space-y-1 text-signal-dim">
          <li>
            <span className="text-online">✓</span> A Lumina bot identity, an install link, and an
            admin consent screen that grants only what the approver holds
          </li>
          <li>
            <span className="text-online">✓</span> Resolving a GitHub repo or npm package into a
            reusable recipe, shared across servers
          </li>
          <li>
            <span className="text-signal-faint">◦</span> Running the bot for you — today it still
            has to be hosted by whoever owns it
          </li>
          <li>
            <span className="text-signal-faint">◦</span> Voice, so music bots can work at all
          </li>
        </ul>
      </div>
    </div>
  );
}

function ServerBotsPanelInner({ serverId }: { serverId: string }) {
  const qc = useQueryClient();
  const [sourceUrl, setSourceUrl] = useState("");

  const { data: requests } = useQuery({
    queryKey: ["botRequests", serverId],
    queryFn: () => api.get<InstallRequest[]>(`/servers/${serverId}/bots/requests`),
    // Only poll while something is actually moving; a settled list is static.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => IN_FLIGHT.has(r.status)) ? 1500 : false),
  });

  const { data: bots } = useQuery({
    queryKey: ["serverBots", serverId],
    queryFn: () => api.get<ServerBot[]>(`/servers/${serverId}/bots`),
  });

  const submit = useMutation({
    mutationFn: (url: string) => api.post<InstallRequest>(`/servers/${serverId}/bots/requests`, { sourceUrl: url }),
    onSuccess: () => {
      setSourceUrl("");
      void qc.invalidateQueries({ queryKey: ["botRequests", serverId] });
    },
  });

  return (
    <div className="space-y-6">
      <HostedBots serverId={serverId} present={new Set((bots ?? []).map((b) => b.username.toLowerCase()))} />

      <section>
        <h3 className="mb-1 font-semibold text-signal">Add a bot</h3>
        <p className="mb-2 text-sm text-signal-dim">
          Paste a GitHub repository or an npm package. A worker works out how it runs, sets up its
          Lumina identity, and remembers what it learned so the next server to want the same bot
          skips all of it.
        </p>
        {/* Said plainly and up front, because it is the single most common disappointment here:
            the famous Discord bots are products, not software you can obtain. */}
        <p className="mb-3 rounded bg-base-900 px-3 py-2 text-xs text-signal-faint">
          A Discord invite link works only if that bot publishes its source. Most well-known bots
          (Dank Memer, MEE6 and the like) are commercial and closed source — they run on their
          author's servers, so there is no copy of them to bring across. Bots you can run yourself
          are the ones that work.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (sourceUrl.trim()) submit.mutate(sourceUrl.trim());
          }}
        >
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="github.com/owner/repo · npm package · discord.com/oauth2/authorize?..."
            className="min-w-0 flex-1 rounded bg-base-900 px-3 py-2 text-sm text-signal placeholder:text-signal-faint"
          />
          <button
            type="submit"
            disabled={!sourceUrl.trim() || submit.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {submit.isPending ? "Sending…" : "Add"}
          </button>
        </form>
        {submit.isError && (
          <p className="mt-2 text-sm text-dnd">
            {submit.error instanceof ApiError ? submit.error.message : "Could not start that request"}
          </p>
        )}
      </section>

      <KnownToWork
        onPick={(url) => submit.mutate(url)}
        picking={submit.isPending}
      />

      {(requests ?? []).length > 0 && (
        <section>
          <h3 className="mb-2 font-semibold text-signal">Recent</h3>
          <div className="space-y-3">
            {(requests ?? []).map((req) => (
              <RequestCard key={req.id} req={req} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 font-semibold text-signal">Bots in this space</h3>
        {(bots ?? []).length === 0 ? (
          <p className="text-sm text-signal-dim">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {(bots ?? []).map((b) => (
              <li key={b.id} className="flex items-center gap-2 rounded bg-base-900 px-3 py-2 text-sm">
                <Bot size={15} className="text-accent" />
                <span className="text-signal">{b.displayName ?? b.username}</span>
                <span className="text-signal-faint">@{b.username}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-signal-faint">
          Bots are ordinary members — remove one from the member list, like any account.
        </p>
      </section>
    </div>
  );
}

/** Sources that were checked to resolve, so there is a path that works without hunting. */
function KnownToWork({ onPick, picking }: { onPick: (sourceUrl: string) => void; picking: boolean }) {
  const { data } = useQuery({
    queryKey: ["botCatalog"],
    queryFn: () => api.get<Recipe[]>("/servers/bots/catalog"),
  });
  const verified = (data ?? []).filter((r) => r.verified && r.sourceUrl);
  if (verified.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 font-semibold text-signal">Known to work here</h3>
      <p className="mb-2 text-sm text-signal-dim">Open-source bots whose source resolves. One click to prepare one.</p>
      <div className="space-y-1">
        {verified.map((r) => (
          <div key={r.id} className="flex items-start gap-2 rounded bg-base-900 px-3 py-2">
            <Bot size={15} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-signal">
                {r.displayName}
                {r.runtime && <span className="ml-2 text-[11px] uppercase text-signal-faint">{r.runtime}</span>}
              </p>
              {r.notes && <p className="text-xs text-signal-faint">{r.notes}</p>}
            </div>
            <button
              type="button"
              disabled={picking}
              onClick={() => onPick(r.sourceUrl!)}
              className="shrink-0 rounded bg-base-700 px-3 py-1 text-xs font-medium text-signal hover:bg-base-600 disabled:opacity-60"
            >
              Add
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function RequestCard({ req }: { req: InstallRequest }) {
  const busy = IN_FLIGHT.has(req.status);
  const failed = req.status === "FAILED";
  // A finished run reads 100 even if the worker's last phase write raced the status write.
  const pct = failed ? req.progress : req.status === "READY" || req.status === "RUNNING" ? 100 : req.progress;

  return (
    <div className="rounded-lg bg-base-900 p-3">
      <div className="mb-2 flex items-center gap-2">
        {busy ? (
          <Loader2 size={15} className="animate-spin text-accent" />
        ) : failed ? (
          <X size={15} className="text-dnd" />
        ) : (
          <Check size={15} className="text-online" />
        )}
        <code className="min-w-0 flex-1 truncate text-xs text-signal-dim">{req.sourceUrl}</code>
        <span className="text-[11px] uppercase text-signal-faint">{req.status}</span>
      </div>

      {/* The bar stays visible after a failure rather than disappearing: where it stopped is the
          clearest statement of how far the worker got. */}
      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className={`text-xs ${failed ? "text-dnd" : "text-signal"}`}>
            {failed ? "Stopped" : (req.phase ?? "Starting")}
          </span>
          <span className="text-[11px] tabular-nums text-signal-faint">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-700">
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${
              failed ? "bg-dnd" : pct === 100 ? "bg-online" : "bg-accent"
            }`}
            style={{ width: `${Math.max(3, Math.min(100, pct))}%` }}
          />
        </div>
      </div>

      <ol className="space-y-1">
        {(req.steps ?? []).map((s, i) => (
          <li key={`${s.key}-${i}`} className="flex gap-2 text-xs">
            <span className={s.ok ? "text-online" : "text-dnd"}>{s.ok ? "✓" : "✗"}</span>
            <span className="min-w-0">
              <span className="text-signal">{s.label}</span>
              {s.detail && <span className="block text-signal-faint">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>

      {req.recipe && (
        <div className="mt-2 rounded bg-base-800 p-2 text-xs text-signal-dim">
          <span className="font-semibold text-signal">How it runs</span>
          {req.recipe.runtime && <span> · {req.recipe.runtime}</span>}
          {req.recipe.installCmd && <div className="mt-1 font-mono text-signal-faint">{req.recipe.installCmd}</div>}
          {req.recipe.startCmd && <div className="font-mono text-signal-faint">{req.recipe.startCmd}</div>}
          {req.recipe.installCount > 1 && (
            <div className="mt-1">Learned once, reused {req.recipe.installCount} times.</div>
          )}
        </div>
      )}

      {req.status === "READY" &&
        (req.applicationExists && req.applicationId ? (
          <InstallLink appId={req.applicationId} />
        ) : (
          <p className="mt-2 rounded bg-base-800 p-2 text-xs text-signal-dim">
            The application this prepared has since been deleted, so its install link no longer
            resolves. Add the bot again to prepare a fresh one.
          </p>
        ))}
    </div>
  );
}

function InstallLink({ appId }: { appId: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${PUBLIC_ORIGIN}/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=1027`;
  return (
    <div className="mt-2 flex items-center gap-1 rounded bg-base-800 p-2">
      <code className="min-w-0 flex-1 truncate text-xs text-signal">{url}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded p-1 text-signal-dim hover:text-signal"
        title="Copy install link"
      >
        {copied ? <Check size={13} className="text-online" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
