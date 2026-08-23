import { useNavigate } from "react-router-dom";
import { Compass, Users, Clapperboard, UserPlus, Check, Clock, Loader2 } from "lucide-react";
import { useState } from "react";
import type { UserDTO, VideoDTO } from "@lumina/shared";
import { useDiscovery, useJoinDiscoverableServer, type DiscoverServerDTO } from "../queries/discovery";
import { useSendFriendRequest } from "../queries/friends";
import { useServers } from "../queries/servers";
import { resolveAssetUrl } from "../lib/apiClient";
import { videoMediaUrl } from "../queries/videos";
import { UserAvatar } from "../components/common/UserAvatar";
import { cn } from "../lib/cn";
import { OfficialServerBadge } from "../components/common/OfficialBadge";

/**
 * Discover — new & popular videos, servers and people, for adults.
 *
 * The popular panels rotate on the server's clock (see backend discovery/rotation.ts), and the
 * page SAYS so: without the "refreshes at" line, a person who visits twice in an hour sees an
 * unchanging page and reasonably concludes the feature is static or broken. The whole point of
 * rotation is invisible unless it is named.
 */
export function DiscoverRoute() {
  const { data, isLoading } = useDiscovery();

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-signal-faint">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (!data) return <div className="flex flex-1 items-center justify-center text-signal-faint">Nothing to discover yet.</div>;

  const refreshAt = new Date(data.rotatesAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="lx-pane flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0 overflow-y-auto">
      {/* w-full is load-bearing, not decoration: this div is a flex ITEM (its parent pane is a
          flex column), and `mx-auto` on a flex item disables the default stretch — so without an
          explicit width it shrink-wraps to its own min-content and can end up WIDER than the pane.
          At 390px that put the right-hand column of cards off the screen. */}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
        <header className="flex items-center gap-3">
          <Compass className="text-accent" size={26} />
          <div>
            <h1 className="text-xl font-bold text-signal">Discover</h1>
            <p className="flex items-center gap-1 text-xs text-signal-faint">
              <Clock size={11} /> Popular picks rotate — next refresh around {refreshAt}
            </p>
          </div>
        </header>

        <VideoSection title="New videos" videos={data.newVideos} />
        <VideoSection title="Popular right now" videos={data.popularVideos} />
        <ServerSection title="Growing servers" servers={data.popularServers} />
        <ServerSection title="New servers" servers={data.newServers} />
        <PeopleSection people={data.people} />
      </div>
    </div>
  );
}

function VideoSection({ title, videos }: { title: string; videos: VideoDTO[] }) {
  const navigate = useNavigate();
  if (videos.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase text-signal-dim">
        <Clapperboard size={14} /> {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {videos.map((v) => (
          <button
            key={v.id}
            onClick={() => navigate("/foryou")}
            className="group min-w-0 overflow-hidden rounded-xl bg-base-800 text-left ring-1 ring-base-600 transition-transform hover:-translate-y-0.5"
          >
            <div className="aspect-[9/12] w-full bg-base-900">
              {v.thumbnailUrl && (
                <img
                  src={videoMediaUrl(v.thumbnailUrl) ?? undefined}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="p-2">
              <p className="truncate text-xs font-medium text-signal">{v.caption || "Untitled"}</p>
              <p className="truncate text-[11px] text-signal-faint">
                {v.author?.displayName ?? v.author?.username ?? "someone"} · {v.likeCount} likes
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function ServerSection({ title, servers }: { title: string; servers: DiscoverServerDTO[] }) {
  const { data: mine } = useServers();
  const join = useJoinDiscoverableServer();
  const navigate = useNavigate();
  const [joining, setJoining] = useState<string | null>(null);
  if (servers.length === 0) return null;
  const memberOf = new Set((mine ?? []).map((s) => s.id));

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase text-signal-dim">
        <Users size={14} /> {title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {servers.map((s) => (
          // min-w-0: a grid item's default `min-width: auto` floors it at its own min-content, so
          // without this the row refuses to shrink into its track and hangs off the right of a
          // phone screen — the text inside truncates, but only once the row is allowed to be narrow.
          <div key={s.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-base-800 p-3 ring-1 ring-base-600">
            {s.iconUrl ? (
              <img src={resolveAssetUrl(s.iconUrl)} alt="" className="size-11 shrink-0 rounded-2xl object-cover" />
            ) : (
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-base-600 text-sm font-bold text-signal">
                {s.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-signal">
                <span className="truncate">{s.name}</span>
                {s.isOfficial ? <OfficialServerBadge compact /> : null}
              </p>
              <p className="truncate text-xs text-signal-faint">
                {s.description || `${s.memberCount} ${s.memberCount === 1 ? "member" : "members"}`}
              </p>
            </div>
            {memberOf.has(s.id) ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-online">
                <Check size={13} /> Joined
              </span>
            ) : (
              <button
                onClick={async () => {
                  setJoining(s.id);
                  try {
                    await join.mutateAsync(s.id);
                    navigate(`/channels/${s.id}/_`);
                  } finally {
                    setJoining(null);
                  }
                }}
                disabled={joining === s.id}
                className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {joining === s.id ? "Joining…" : "Join"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function PeopleSection({ people }: { people: UserDTO[] }) {
  const sendRequest = useSendFriendRequest();
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  if (people.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase text-signal-dim">
        <UserPlus size={14} /> People to meet
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {people.map((u) => (
          <div key={u.id} className="flex flex-col items-center gap-2 rounded-xl bg-base-800 p-4 ring-1 ring-base-600">
            <UserAvatar avatarUrl={u.avatarUrl} name={u.displayName ?? u.username} size={48} />
            <p className="w-full truncate text-center text-sm font-medium text-signal">
              {u.displayName ?? u.username}
            </p>
            <button
              onClick={async () => {
                setFailed(null);
                try {
                  await sendRequest.mutateAsync(u.username);
                  setSent((prev) => new Set(prev).add(u.id));
                } catch {
                  // Privacy settings can refuse this (allowFriendRequests=false) and that refusal
                  // is the other person's call — shown quietly, never as an error screen.
                  setFailed(u.id);
                }
              }}
              disabled={sent.has(u.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold",
                sent.has(u.id) ? "bg-base-600 text-signal-dim" : "bg-accent text-white hover:bg-accent-hover",
              )}
            >
              {sent.has(u.id) ? "Request sent" : failed === u.id ? "Not available" : "Add friend"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
