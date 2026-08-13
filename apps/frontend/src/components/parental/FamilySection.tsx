import { useState } from "react";
import { UserPlus, ShieldCheck, Trash2, AlertTriangle, MessagesSquare, Users, Server as ServerIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../common/UserAvatar";
import {
  useLinkedChildren,
  useRedeemPairingCode,
  useRevokeLink,
  useChildContacts,
  useChildMessages,
  useChildServers,
  useChildFriends,
  useApproveContact,
  useRevokeApprovedContact,
} from "../../queries/parental";
import type { LinkedChildDTO } from "@lumina/shared";

/**
 * The adult side of parental controls: pair a child, then see everything on their account.
 *
 * Lives in Settings rather than as its own top-level route because it is account configuration,
 * not a place you spend time — and because an adult with no linked child should not have a
 * permanent nav entry for a feature they do not use.
 */
export function FamilySection() {
  const { data: children } = useLinkedChildren();
  const redeem = useRedeemPairingCode();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);

  const active = children?.find((c) => c.child.id === activeChildId) ?? children?.[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="text-xs font-bold uppercase text-signal-dim">Link a child's account</span>
        <p className="mb-2 text-sm text-signal-faint">
          Ask them for the pairing code shown on their screen, then enter it here. You'll be able to see
          their messages, contacts and servers.
        </p>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD2345"
            maxLength={16}
            aria-label="Pairing code"
            className="flex-1 rounded bg-base-900 px-3 py-2 font-mono tracking-widest text-signal outline-none ring-1 ring-base-500 focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={async () => {
              setError(null);
              try {
                await redeem.mutateAsync(code.trim());
                setCode("");
              } catch (e) {
                setError(e instanceof Error ? e.message : "That code didn't work.");
              }
            }}
            disabled={redeem.isPending || code.trim().length < 4}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            <UserPlus size={15} className="mr-1.5 inline" />
            Link
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-dnd">{error}</p>}
      </div>

      {children && children.length > 0 && (
        <>
          {children.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {children.map((c) => (
                <button
                  key={c.child.id}
                  onClick={() => setActiveChildId(c.child.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm",
                    active?.child.id === c.child.id ? "bg-accent text-white" : "bg-base-900 text-signal-dim hover:bg-base-800",
                  )}
                >
                  <UserAvatar avatarUrl={c.child.avatarUrl} name={c.child.username} size={18} />
                  {c.child.displayName ?? c.child.username}
                </button>
              ))}
            </div>
          )}
          {active && <ChildPanel link={active} />}
        </>
      )}

      {children?.length === 0 && (
        <p className="rounded-lg bg-base-900 p-4 text-sm text-signal-faint">
          No linked accounts yet.
        </p>
      )}
    </div>
  );
}

function ChildPanel({ link }: { link: LinkedChildDTO }) {
  const childId = link.child.id;
  const [tab, setTab] = useState<"contacts" | "messages" | "servers" | "approved">("contacts");
  const revokeLink = useRevokeLink();

  return (
    <div className="rounded-xl bg-base-900 p-4">
      <div className="mb-3 flex items-center gap-2">
        <UserAvatar avatarUrl={link.child.avatarUrl} name={link.child.username} size={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-signal">{link.child.displayName ?? link.child.username}</p>
          <p className="truncate text-xs text-signal-faint">@{link.child.username}</p>
        </div>
        <button
          onClick={() => {
            if (confirm(`Stop supervising ${link.child.username}? Their account will be locked until a parent links again.`)) {
              revokeLink.mutate(link.linkId);
            }
          }}
          className="text-xs text-dnd hover:underline"
        >
          Unlink
        </button>
      </div>

      <div className="mb-3 flex gap-1 border-b border-base-700">
        {([
          ["contacts", "Who they talk to", Users],
          ["messages", "Messages", MessagesSquare],
          ["servers", "Servers", ServerIcon],
          ["approved", "Allowed adults", ShieldCheck],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-medium",
              tab === key ? "border-accent text-signal" : "border-transparent text-signal-dim hover:text-signal",
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {tab === "contacts" && <ContactsTab childId={childId} />}
      {tab === "messages" && <MessagesTab childId={childId} />}
      {tab === "servers" && <ServersTab childId={childId} />}
      {tab === "approved" && <ApprovedTab link={link} />}
    </div>
  );
}

function ContactsTab({ childId }: { childId: string }) {
  const { data: contacts } = useChildContacts(childId);
  const { data: friends } = useChildFriends(childId);
  if (!contacts?.length && !friends?.length) {
    return <p className="text-sm text-signal-faint">No conversations or friends yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <Section title="Direct messages" rows={contacts?.map((c) => ({ user: c.user, isAdult: c.isAdult })) ?? []} />
      <Section title="Friends" rows={friends ?? []} />
    </div>
  );
}

/** Adults are called out explicitly. A parent scanning this list is looking for exactly one thing,
 * and making them cross-reference ages themselves would defeat the point of the screen. */
function Section({ title, rows }: { title: string; rows: { user: { id: string; username: string; displayName: string | null; avatarUrl: string | null }; isAdult: boolean }[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold uppercase text-signal-dim">{title}</p>
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.user.id} className="flex items-center gap-2 rounded bg-base-800 px-2.5 py-1.5">
            <UserAvatar avatarUrl={r.user.avatarUrl} name={r.user.username} size={22} />
            <span className="min-w-0 flex-1 truncate text-sm text-signal">
              {r.user.displayName ?? r.user.username}
            </span>
            {r.isAdult && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-dnd/20 px-1.5 py-0.5 text-[10px] font-semibold text-dnd">
                <AlertTriangle size={10} /> Adult
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MessagesTab({ childId }: { childId: string }) {
  const { data: messages } = useChildMessages(childId);
  if (!messages?.length) return <p className="text-sm text-signal-faint">Nothing posted yet.</p>;
  return (
    <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
      {messages.map((m) => (
        <div key={m.id} className="rounded bg-base-800 px-2.5 py-1.5">
          <p className="text-xs text-signal-faint">{new Date(m.createdAt).toLocaleString()}</p>
          <p className="whitespace-pre-wrap break-words text-sm text-signal">{m.content || "(attachment)"}</p>
        </div>
      ))}
    </div>
  );
}

function ServersTab({ childId }: { childId: string }) {
  const { data: servers } = useChildServers(childId);
  if (!servers?.length) return <p className="text-sm text-signal-faint">Not in any servers.</p>;
  return (
    <div className="flex flex-col gap-1">
      {servers.map((s) => (
        <div key={s.server.id} className="rounded bg-base-800 px-2.5 py-1.5">
          <p className="text-sm text-signal">{s.server.name}</p>
          <p className="text-xs text-signal-faint">Joined {new Date(s.joinedAt).toLocaleDateString()}</p>
        </div>
      ))}
    </div>
  );
}

function ApprovedTab({ link }: { link: LinkedChildDTO }) {
  const childId = link.child.id;
  const approve = useApproveContact(childId);
  const revoke = useRevokeApprovedContact(childId);
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-signal-faint">
        Adults you allow here can find and message <span className="text-signal">{link.child.username}</span> — and
        only them. This does not let them contact any other young person on Lumina.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          aria-label="Username to allow"
          className="flex-1 rounded bg-base-800 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-600 focus:ring-2 focus:ring-accent"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="who is this? (e.g. aunt)"
          aria-label="Note"
          className="flex-1 rounded bg-base-800 px-3 py-2 text-sm text-signal outline-none ring-1 ring-base-600 focus:ring-2 focus:ring-accent"
        />
        <button
          onClick={async () => {
            setError(null);
            try {
              await approve.mutateAsync({ username: username.trim(), note: note.trim() || undefined });
              setUsername("");
              setNote("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not add that person.");
            }
          }}
          disabled={approve.isPending || !username.trim()}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          Allow
        </button>
      </div>
      {error && <p className="text-sm text-dnd">{error}</p>}

      {link.approvedContacts.length === 0 ? (
        <p className="text-sm text-signal-faint">Nobody allowed yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {link.approvedContacts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded bg-base-800 px-2.5 py-1.5">
              <UserAvatar avatarUrl={a.user.avatarUrl} name={a.user.username} size={22} />
              <span className="min-w-0 flex-1 truncate text-sm text-signal">
                {a.user.displayName ?? a.user.username}
                {a.note && <span className="ml-1.5 text-xs text-signal-faint">· {a.note}</span>}
              </span>
              <button
                onClick={() => revoke.mutate(a.user.id)}
                className="shrink-0 rounded p-1 text-signal-faint hover:text-dnd"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
