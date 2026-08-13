import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Code2, Bot, RefreshCw, Trash2, Copy, Check, ExternalLink, Plus, KeyRound, Puzzle } from "lucide-react";
import { cn } from "../../lib/cn";
import { api } from "../../lib/apiClient";
import { useAuthStore } from "../../store/authStore";
import {
  useMyApplications,
  useCreateApplication,
  useRegenerateBotToken,
  useDeleteApplication,
  useUpdateRedirectUris,
  useRegenerateClientSecret,
} from "../../queries/applications";
import { DOC_PAGES, NAV_SECTIONS, type DocBlock } from "../../devportal/content";

/**
 * The developer portal: a real web suite at /developers rather than a settings tab. Docs are
 * public (a developer evaluating the platform shouldn't need an account to read them); the
 * application manager appears for signed-in users. The curated pages here complement — never
 * replace — the generated Swagger reference at /api/docs.
 */
export function DevPortalRoute() {
  const { pageId } = useParams<{ pageId?: string }>();
  const user = useAuthStore((s) => s.user);
  const activeDoc = DOC_PAGES.find((d) => d.id === pageId);
  const showApps = pageId === "apps";

  return (
    <div className="flex min-h-screen bg-base-800 text-signal">
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-base-600 bg-base-900 p-4 md:flex">
        <Link to="/developers" className="flex items-center gap-2 text-sm font-bold text-signal">
          <Code2 size={18} className="text-accent" /> Lumina Developers
        </Link>
        <Link
          to="/developers/apps"
          className={cn(
            "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium",
            showApps ? "bg-accent text-white" : "text-signal-dim hover:bg-base-800 hover:text-signal",
          )}
        >
          <Bot size={15} /> Your Applications
        </Link>
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="mb-1 px-2.5 text-[11px] font-bold uppercase tracking-wide text-signal-faint">{section.label}</p>
            {section.ids.map((id) => {
              const page = DOC_PAGES.find((d) => d.id === id)!;
              return (
                <Link
                  key={id}
                  to={`/developers/${id}`}
                  className={cn(
                    "block rounded-lg px-2.5 py-1.5 text-sm",
                    pageId === id ? "bg-base-600 text-signal" : "text-signal-dim hover:bg-base-800 hover:text-signal",
                  )}
                >
                  {page.nav}
                </Link>
              );
            })}
          </div>
        ))}
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          className="mt-auto flex items-center gap-1.5 px-2.5 text-xs text-signal-faint hover:text-signal"
        >
          <ExternalLink size={12} /> Full REST reference (Swagger)
        </a>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
          {/* Mobile nav strip */}
          <div className="mb-4 flex gap-2 overflow-x-auto md:hidden">
            <Link to="/developers/apps" className="shrink-0 rounded-lg bg-base-900 px-2.5 py-1.5 text-xs text-signal ring-1 ring-base-600">Apps</Link>
            {DOC_PAGES.map((d) => (
              <Link key={d.id} to={`/developers/${d.id}`} className={cn("shrink-0 rounded-lg px-2.5 py-1.5 text-xs ring-1", pageId === d.id ? "bg-accent text-white ring-accent" : "bg-base-900 text-signal-dim ring-base-600")}>
                {d.nav}
              </Link>
            ))}
          </div>

          {showApps ? (
            user ? <AppsPanel /> : <SignInPrompt />
          ) : activeDoc ? (
            <DocRenderer page={activeDoc} />
          ) : (
            <PortalLanding />
          )}
        </div>
      </main>
    </div>
  );
}

function PortalLanding() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-signal">Build on Lumina</h1>
      <p className="mt-2 max-w-xl text-sm text-signal-dim">
        Bots that are real members. Sign-in-with-Lumina. Embedded Activities. Server add-ons, webhooks,
        game integrations — and a Discord-compatible endpoint so the bot you already wrote can move in.
        Everything runs against the same API the official apps use.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {[
          { to: "/developers/getting-started", icon: Code2, title: "Getting started", blurb: "Create an app and post your first message in five minutes." },
          { to: "/developers/apps", icon: Bot, title: "Your applications", blurb: "Tokens, OAuth2 credentials, redirect URIs, Activities." },
          { to: "/developers/discord-compat", icon: Puzzle, title: "Bring your Discord bot", blurb: "Point discord.js at Lumina and log in with your Lumina token." },
          { to: "/developers/authentication", icon: KeyRound, title: "OAuth2", blurb: "Let people sign into your app with their Lumina account." },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="rounded-xl bg-base-900 p-4 ring-1 ring-base-600 hover:ring-accent">
            <c.icon size={18} className="text-accent" />
            <p className="mt-2 text-sm font-bold text-signal">{c.title}</p>
            <p className="mt-1 text-xs text-signal-faint">{c.blurb}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SignInPrompt() {
  const navigate = useNavigate();
  return (
    <div className="rounded-xl bg-base-900 p-6 text-center ring-1 ring-base-600">
      <p className="text-sm text-signal-dim">Sign in to create and manage applications.</p>
      <button onClick={() => navigate("/login")} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">
        Sign in
      </button>
    </div>
  );
}

function DocRenderer({ page }: { page: (typeof DOC_PAGES)[number] }) {
  return (
    <article>
      <h1 className="text-2xl font-bold text-signal">{page.title}</h1>
      <div className="mt-4 flex flex-col gap-4">
        {page.blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </article>
  );
}

function Block({ block }: { block: DocBlock }) {
  if (block.kind === "h2") return <h2 className="mt-3 text-lg font-bold text-signal">{block.text}</h2>;
  if (block.kind === "p") return <p className="text-sm leading-relaxed text-signal-dim">{block.text}</p>;
  if (block.kind === "note") {
    return <p className="rounded-lg border-l-2 border-accent bg-accent/5 px-3 py-2 text-sm text-signal-dim">{block.text}</p>;
  }
  if (block.kind === "code") {
    return (
      <pre className="overflow-x-auto rounded-lg bg-base-950 p-3 text-xs leading-relaxed text-signal ring-1 ring-base-600">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="overflow-x-auto rounded-lg ring-1 ring-base-600">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-base-900">
              {block.header?.map((h) => (
                <th key={h} className="px-3 py-2 text-xs font-bold uppercase text-signal-dim">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows?.map((row, i) => (
              <tr key={i} className="border-t border-base-700">
                {row.map((cell, j) => (
                  <td key={j} className={cn("px-3 py-2 align-top text-signal-dim", j === 0 && "whitespace-nowrap font-medium text-signal")}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- applications manager

interface ActivityDTO { id: string; name: string; url: string; applicationId?: string }

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded p-1 text-signal-faint hover:text-signal"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-online" /> : <Copy size={13} />}
    </button>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-base-950 p-2.5 ring-1 ring-accent/50">
      <p className="text-[11px] font-bold uppercase text-accent">{label} — shown once, copy it now</p>
      <div className="mt-1 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 break-all text-xs text-signal">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

function AppsPanel() {
  const { data: apps, isLoading } = useMyApplications(true);
  const createApp = useCreateApplication();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);

  return (
    <div>
      <h1 className="text-2xl font-bold text-signal">Your Applications</h1>
      <div className="mt-4 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New application name"
          aria-label="New application name"
          maxLength={60}
          className="flex-1 rounded-lg bg-base-900 px-3 py-2 text-sm text-signal ring-1 ring-base-600 focus:ring-2 focus:ring-accent"
        />
        <button
          onClick={async () => {
            const result = await createApp.mutateAsync({ name: name.trim() });
            setCreated({ id: result.id, token: result.botToken });
            setName("");
          }}
          disabled={!name.trim() || createApp.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Plus size={15} /> Create
        </button>
      </div>
      {created && <div className="mt-3"><Secret label="Bot token" value={created.token} /></div>}

      <div className="mt-6 flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-signal-faint">Loading…</p>
        ) : apps?.length ? (
          apps.map((app) => <AppCard key={app.id} app={app} />)
        ) : (
          <p className="rounded-xl bg-base-900 p-4 text-sm text-signal-faint ring-1 ring-base-600">
            No applications yet — create one above. You'll get a bot account and OAuth2 credentials.
          </p>
        )}
      </div>
    </div>
  );
}

function AppCard({ app }: { app: NonNullable<ReturnType<typeof useMyApplications>["data"]>[number] }) {
  const queryClient = useQueryClient();
  const regenerateToken = useRegenerateBotToken();
  const regenerateSecret = useRegenerateClientSecret();
  const updateUris = useUpdateRedirectUris();
  const deleteApp = useDeleteApplication();
  const [revealed, setRevealed] = useState<{ label: string; value: string } | null>(null);
  const [uris, setUris] = useState(app.redirectUris.join("\n"));
  const [activityName, setActivityName] = useState("");
  const [activityUrl, setActivityUrl] = useState("");

  const { data: activities } = useQuery({
    queryKey: ["activities", "all"],
    queryFn: () => api.get<ActivityDTO[]>("/activities"),
  });
  const mine = useMemo(
    () => (activities ?? []).filter((a) => (a as { applicationId?: string }).applicationId === app.id || (a as { application?: { name: string } }).application?.name === app.name),
    [activities, app.id, app.name],
  );
  const addActivity = useMutation({
    mutationFn: () => api.post<ActivityDTO>(`/applications/${app.id}/activities`, { name: activityName.trim(), url: activityUrl.trim() }),
    onSuccess: () => {
      setActivityName(""); setActivityUrl("");
      void queryClient.invalidateQueries({ queryKey: ["activities"] });
    },
  });
  const removeActivity = useMutation({
    mutationFn: (id: string) => api.delete(`/activities/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["activities"] }),
  });

  return (
    <div className="rounded-xl bg-base-900 p-4 ring-1 ring-base-600">
      <div className="flex items-center gap-2">
        <Bot size={18} className="shrink-0 text-signal-faint" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-signal">{app.name}</p>
          <p className="truncate text-xs text-signal-faint">bot @{app.botUsername}</p>
        </div>
        <button
          onClick={() => {
            if (confirm(`Delete "${app.name}"? Its bot leaves every server; OAuth grants stop working.`)) deleteApp.mutate(app.id);
          }}
          className="rounded p-1.5 text-signal-faint hover:text-dnd"
          title="Delete application"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-base-800 p-3">
          <p className="text-[11px] font-bold uppercase text-signal-dim">Client ID</p>
          <div className="mt-1 flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate text-xs text-signal">{app.id}</code>
            <CopyButton value={app.id} />
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-base-800 p-3">
          <button
            onClick={async () => {
              const r = await regenerateToken.mutateAsync(app.id);
              setRevealed({ label: "Bot token", value: r.botToken });
            }}
            className="flex items-center gap-1.5 rounded bg-base-600 px-2.5 py-1.5 text-xs font-medium text-signal hover:bg-base-500"
          >
            <RefreshCw size={12} /> Reset bot token
          </button>
          <button
            onClick={async () => {
              const r = await regenerateSecret.mutateAsync(app.id);
              setRevealed({ label: "Client secret", value: r.clientSecret });
            }}
            className="flex items-center gap-1.5 rounded bg-base-600 px-2.5 py-1.5 text-xs font-medium text-signal hover:bg-base-500"
          >
            <KeyRound size={12} /> Reset secret
          </button>
        </div>
      </div>
      {revealed && <div className="mt-2"><Secret label={revealed.label} value={revealed.value} /></div>}

      <div className="mt-3">
        <p className="text-[11px] font-bold uppercase text-signal-dim">OAuth2 redirect URIs (one per line)</p>
        <textarea
          value={uris}
          onChange={(e) => setUris(e.target.value)}
          onBlur={() => {
            const next = uris.split("\n").map((u) => u.trim()).filter(Boolean);
            if (JSON.stringify(next) !== JSON.stringify(app.redirectUris)) {
              updateUris.mutate({ applicationId: app.id, redirectUris: next });
            }
          }}
          rows={2}
          className="mt-1 w-full rounded-lg bg-base-800 px-2.5 py-1.5 font-mono text-xs text-signal ring-1 ring-base-600"
          placeholder="https://yourapp.example/callback"
        />
      </div>

      <div className="mt-3">
        <p className="text-[11px] font-bold uppercase text-signal-dim">Activities</p>
        {mine.map((a) => (
          <div key={a.id} className="mt-1 flex items-center gap-2 rounded bg-base-800 px-2.5 py-1.5 text-xs">
            <span className="font-medium text-signal">{a.name}</span>
            <span className="min-w-0 flex-1 truncate text-signal-faint">{a.url}</span>
            <button onClick={() => removeActivity.mutate(a.id)} className="text-signal-faint hover:text-dnd" title="Remove activity">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <div className="mt-1.5 flex gap-1.5">
          <input value={activityName} onChange={(e) => setActivityName(e.target.value)} placeholder="Name" aria-label="Activity name" className="w-28 rounded bg-base-800 px-2 py-1.5 text-xs text-signal ring-1 ring-base-600" />
          <input value={activityUrl} onChange={(e) => setActivityUrl(e.target.value)} placeholder="https://…" aria-label="Activity URL" className="flex-1 rounded bg-base-800 px-2 py-1.5 text-xs text-signal ring-1 ring-base-600" />
          <button
            onClick={() => addActivity.mutate()}
            disabled={!activityName.trim() || !activityUrl.trim().startsWith("https://") || addActivity.isPending}
            className="rounded bg-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
