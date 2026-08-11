import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Copy, Check, Loader2, ShieldOff, ShieldCheck } from "lucide-react";
import { api } from "../lib/apiClient";
import { reportError, toast } from "../store/toastStore";
import { UserAvatar } from "../components/common/UserAvatar";

interface OfficialAccount {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  platformRole: string;
  isBot: boolean;
  createdAt: string;
}

interface GeneratedAccount {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  password: string;
}

/**
 * Minting first-party Lumina accounts. MASTER only.
 *
 * Each one gets the Lumina logo as its avatar, "Official Lumina Staff" as its bio, and the
 * `isOfficial` badge. The badge is the part that matters: anyone can copy a logo and a bio, so an
 * identity claim only means something if it comes from somewhere a user can't write to.
 */
export function OwnerOfficialAccountsPanel() {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ["master", "official"],
    queryFn: () => api.get<OfficialAccount[]>("/master/official-accounts"),
  });

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [generated, setGenerated] = useState<GeneratedAccount | null>(null);

  const create = useMutation({
    mutationFn: (body: { username: string; displayName?: string }) =>
      api.post<GeneratedAccount>("/master/official-accounts", body),
    onSuccess: (account) => {
      // Held in component state on purpose, and never refetched: the server returns the password
      // exactly once and stores no readable copy, so this is the only moment it exists anywhere.
      setGenerated(account);
      setUsername("");
      setDisplayName("");
      void queryClient.invalidateQueries({ queryKey: ["master", "official"] });
    },
    onError: (e) => reportError(e, "Couldn't create that account"),
  });

  const setBadge = useMutation({
    mutationFn: ({ id, isOfficial }: { id: string; isOfficial: boolean }) =>
      api.patch(`/master/official-accounts/${id}`, { isOfficial }),
    onSuccess: () => {
      toast.success("Badge updated");
      void queryClient.invalidateQueries({ queryKey: ["master", "official"] });
    },
    onError: (e) => reportError(e, "Couldn't change that badge"),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-hairline bg-base-900 p-3 text-sm text-signal-dim">
        <p className="flex items-start gap-2">
          <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            Official accounts carry the Lumina logo, the staff bio, and a badge that only you can
            grant. The badge is the point — anyone can copy the picture and the wording, so it's the
            only part that proves an account really is us.
          </span>
        </p>
      </div>

      {generated && <GeneratedCredentials account={generated} onDone={() => setGenerated(null)} />}

      <div className="flex flex-col gap-2 rounded-lg border border-hairline bg-base-900 p-3">
        <span className="text-xs font-bold uppercase text-signal-dim">New official account</span>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Username for the new official account"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            className="min-w-0 flex-1 rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
          <input
            aria-label="Display name for the new official account"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional)"
            className="min-w-0 flex-1 rounded bg-base-700 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            disabled={!/^[a-zA-Z0-9_]{3,32}$/.test(username.trim()) || create.isPending}
            onClick={() =>
              create.mutate({ username: username.trim(), displayName: displayName.trim() || undefined })
            }
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Generate
          </button>
        </div>
        <p className="text-xs text-signal-faint">
          3–32 letters, numbers or underscores. The password is generated and shown once.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {accounts.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : (accounts.data ?? []).length === 0 ? (
          <p className="text-sm text-signal-dim">No official accounts yet.</p>
        ) : (
          accounts.data!.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-lg border border-hairline bg-base-900 p-3">
              <UserAvatar avatarUrl={a.avatarUrl} name={a.displayName ?? a.username} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-signal">{a.displayName ?? a.username}</span>
                  <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-accent" aria-label="Official" />
                </div>
                <p className="truncate text-xs text-signal-faint">
                  @{a.username} · {a.bio}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBadge.mutate({ id: a.id, isOfficial: false })}
                disabled={setBadge.isPending}
                title="Remove the official badge (keeps the account)"
                aria-label={`Remove the official badge from ${a.username}`}
                className="shrink-0 rounded p-1.5 text-signal-faint hover:text-dnd disabled:opacity-50"
              >
                <ShieldOff className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The one and only sighting of a generated password.
 *
 * Deliberately blocking and deliberately loud: the server keeps no readable copy, so a person who
 * closes this without copying has to reset the account. Saying that here is cheaper than the
 * support conversation that follows not saying it.
 */
function GeneratedCredentials({ account, onDone }: { account: GeneratedAccount; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-lg border border-online/50 bg-online/10 p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-online" />
        <span className="font-semibold text-signal">@{account.username} created</span>
      </div>
      <p className="mt-1.5 text-xs text-amber">
        This password is shown once and isn't stored anywhere readable. Copy it now or you'll have to
        reset the account.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-base-900 px-2 py-1.5 font-mono text-xs text-signal">
          {account.password}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(`${account.email}\n${account.password}`).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="flex shrink-0 items-center gap-1 rounded bg-base-700 px-2 py-1.5 text-xs font-medium text-signal hover:bg-base-600"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-online" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-signal-faint">Sign in with {account.email}</p>
      <button type="button" onClick={onDone} className="mt-2 text-xs font-medium text-accent hover:underline">
        I've saved it
      </button>
    </div>
  );
}
