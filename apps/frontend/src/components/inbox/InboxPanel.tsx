import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Reply, SmilePlus, Heart, MessageCircle, UserCheck, TrendingUp, Coins, MessagesSquare } from "lucide-react";
import { cn } from "../../lib/cn";
import { UserAvatar } from "../common/UserAvatar";
import { useInbox, useMarkInboxRead, type InboxItemDTO } from "../../queries/inbox";

const KIND_META: Record<InboxItemDTO["kind"], { icon: typeof Bell; verb: string }> = {
  REPLY: { icon: Reply, verb: "replied to your message" },
  REACTION: { icon: SmilePlus, verb: "reacted to your message" },
  VIDEO_LIKE: { icon: Heart, verb: "liked your video" },
  VIDEO_COMMENT: { icon: MessageCircle, verb: "commented on your video" },
  THREAD: { icon: MessagesSquare, verb: "started a thread on your message" },
  FRIEND_ACCEPT: { icon: UserCheck, verb: "accepted your friend request" },
  LEVEL_UP: { icon: TrendingUp, verb: "" },
  EARNING: { icon: Coins, verb: "" },
};

function actorLine(item: InboxItemDTO): string {
  const meta = KIND_META[item.kind];
  if (!item.actor) return item.preview ?? meta.verb;
  const name = item.actor.displayName ?? item.actor.username;
  const others = item.actorCount > 1 ? ` and ${item.actorCount - 1} other${item.actorCount > 2 ? "s" : ""}` : "";
  return `${name}${others} ${meta.verb}`;
}

/**
 * The unified Activity list — shared by the desktop bell popover and the mobile Activity tab, so
 * the two surfaces cannot drift. Marks everything read on mount: opening the inbox IS reading it,
 * and per-row read ceremony is busywork no one performs.
 */
export function InboxPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { data: items, isLoading } = useInbox();
  const markRead = useMarkInboxRead();
  const navigate = useNavigate();

  useEffect(() => {
    if (items?.some((i) => i.readAt === null)) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items?.length]);

  if (isLoading) return <p className="p-4 text-sm text-signal-faint">Loading…</p>;
  if (!items?.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <Bell size={28} className="text-signal-faint" />
        <p className="text-sm text-signal-dim">Nothing yet</p>
        <p className="text-xs text-signal-faint">Replies, reactions, likes and level-ups land here.</p>
      </div>
    );
  }

  function open(item: InboxItemDTO) {
    onNavigate?.();
    if (item.serverId && item.channelId) navigate(`/channels/${item.serverId}/${item.channelId}`);
    else if (item.videoId) navigate("/foryou");
    else if (item.kind === "EARNING") navigate("/studio");
    else if (item.kind === "FRIEND_ACCEPT") navigate("/friends");
  }

  return (
    <div className="flex max-h-[70vh] flex-col overflow-y-auto">
      {items.map((item) => {
        const Icon = KIND_META[item.kind].icon;
        return (
          <button
            key={item.id}
            onClick={() => open(item)}
            className={cn(
              "flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-base-700/60",
              item.readAt === null && "bg-accent/5",
            )}
          >
            {item.actor ? (
              <UserAvatar avatarUrl={item.actor.avatarUrl} name={item.actor.username} size={30} />
            ) : (
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-base-600">
                <Icon size={15} className="text-accent" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-signal">{actorLine(item)}</span>
              {item.preview && item.actor && (
                <span className="block truncate text-xs text-signal-faint">{item.preview}</span>
              )}
              <span className="block text-[11px] text-signal-faint">
                {new Date(item.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </span>
            </span>
            <Icon size={14} className="mt-1 shrink-0 text-signal-faint" />
          </button>
        );
      })}
    </div>
  );
}
