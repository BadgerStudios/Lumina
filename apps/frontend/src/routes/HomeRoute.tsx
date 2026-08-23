import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Clapperboard, Compass, Plus, Sparkles, Users } from "lucide-react";
import { useDMs } from "../queries/dms";
import { useServers } from "../queries/servers";
import { useFriendRequests } from "../queries/friends";
import { useAuthStore } from "../store/authStore";
import { useUIStore } from "../store/uiStore";
import { UserAvatar } from "../components/common/UserAvatar";
import { SpaceAvatar } from "../components/layout/NavDeck";
import { usePresenceStore } from "../store/presenceStore";

/**
 * Home.
 *
 * This route used to be the conversation list plus, on anything wider than a phone, the words
 * "Select a conversation, or pick a server from the rail on the left" — an instruction, shown to
 * someone who had just arrived, about how to use furniture they could already see.
 *
 * The list moved into the deck, so the space is free to answer the question you actually open the
 * app with: what happened while I was gone? Recent conversations, the spaces you are in, and the
 * one or two things waiting on you.
 */

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function HomeRoute() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isConfirmedAdult = useAuthStore((s) => s.user?.ageVerified === true && s.user?.isMinor === false);
  const { data: conversations } = useDMs();
  const { data: servers } = useServers();
  const { data: friendRequests } = useFriendRequests();
  const presenceByUserId = usePresenceStore((s) => s.presenceByUserId);
  const openModalWith = useUIStore((s) => s.openModalWith);

  const name = user?.displayName ?? user?.username ?? "";
  const recent = (conversations ?? []).slice(0, 6);
  const incoming = friendRequests?.incoming.length ?? 0;

  const shortcuts = [
    ...(isConfirmedAdult
      ? [
          { to: "/foryou", label: "For You", note: "Short video", icon: Clapperboard },
          { to: "/discover", label: "Discover", note: "Find spaces", icon: Compass },
          { to: "/studio", label: "Studio", note: "Your earnings", icon: Sparkles },
        ]
      : []),
    { to: "/friends", label: "Friends", note: incoming ? `${incoming} waiting` : "Your people", icon: Users },
  ];

  return (
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col overflow-y-auto max-md:rounded-none max-md:border-x-0 max-md:border-b-0">
      <div className="mx-auto w-full max-w-3xl px-5 py-8">
        <p className="lx-eyebrow">Home</p>
        <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-signal">
          {name ? `Welcome back, ${name}.` : "Welcome back."}
        </h1>
        <p className="mt-1 text-sm text-signal-dim">
          Press <kbd className="rounded border border-hairline px-1 font-mono text-[10px]">⌘K</kbd> to jump anywhere.
        </p>

        {/* Shortcuts */}
        <div className="mt-7 grid gap-2 sm:grid-cols-2">
          {shortcuts.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.to}
                to={s.to}
                className="group flex min-w-0 items-center gap-3 rounded-xl border border-hairline bg-base-900/40 px-3.5 py-3 transition hover:border-accent"
              >
                <Icon size={17} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-signal">{s.label}</span>
                  <span className="block truncate font-mono text-[10px] text-signal-faint">{s.note}</span>
                </span>
                <ArrowRight size={14} className="shrink-0 text-signal-faint transition group-hover:translate-x-0.5" />
              </Link>
            );
          })}
        </div>

        {/* Conversations */}
        <div className="mt-9 flex items-baseline justify-between">
          <p className="lx-eyebrow">Recent conversations</p>
          {recent.length > 0 && (
            <Link to="/friends" className="font-mono text-[10px] text-signal-faint hover:text-signal">
              find people
            </Link>
          )}
        </div>
        {recent.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-hairline px-4 py-6 text-center text-sm text-signal-faint">
            No conversations yet. Add a friend and say hello.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-0.5">
            {recent.map((c) => {
              const other = c.participants.find((p) => p.id !== user?.id) ?? c.participants[0];
              const label = c.isGroup
                ? (c.name ?? c.participants.map((p) => p.displayName ?? p.username).join(", "))
                : (other?.displayName ?? other?.username ?? "Unknown");
              return (
                <button key={c.id} onClick={() => navigate(`/dm/${c.id}`)} className="lx-row">
                  <UserAvatar
                    avatarUrl={other?.avatarUrl ?? null}
                    name={label}
                    size={30}
                    presence={other ? (presenceByUserId[other.id] ?? other.presence) : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-signal">{label}</span>
                    <span className="block truncate text-xs text-signal-faint">
                      {c.lastMessage?.content || (c.lastMessage ? "Attachment" : "No messages yet")}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-signal-faint">
                    {relativeTime(c.lastMessage?.createdAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Spaces */}
        <p className="lx-eyebrow mt-9">Your spaces</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(servers ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(`/channels/${s.id}/_`)}
              className="flex min-w-0 items-center gap-3 rounded-xl border border-hairline bg-base-900/40 px-3 py-2.5 text-left transition hover:border-accent"
            >
              <SpaceAvatar name={s.name} iconUrl={s.iconUrl} size={32} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-signal">{s.name}</span>
            </button>
          ))}
          <button
            onClick={() => openModalWith("createServer")}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-hairline px-3 py-2.5 text-left text-signal-faint transition hover:border-accent hover:text-signal"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline">
              <Plus size={15} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">Create or join a space</span>
          </button>
        </div>
      </div>
    </div>
  );
}
