import { UserPlus, UserCheck, Clock, Check } from "lucide-react";
import {
  useFriends,
  useFriendRequests,
  useSendFriendRequest,
  useRespondToFriendRequest,
} from "../../queries/friends";
import { useAuthStore } from "../../store/authStore";
import { reportError, toast } from "../../store/toastStore";
import { cn } from "../../lib/cn";

/**
 * The one place friendship state turns into a button, wherever a user is shown.
 *
 * Sending a friend request used to be possible from exactly one surface — the "Add Friend" tab of
 * the Friends page — so meeting someone in a channel, a member list or a profile popover gave you
 * no way to add them without leaving, remembering their username and searching for it again. That
 * makes the friend graph far sparser than the actual social graph, which then starves everything
 * built on top of it (recommendations, the Following feed, DM suggestions).
 *
 * Relationship state is DERIVED from the two lists the app already keeps warm rather than fetched
 * per user: DMSidebar mounts useFriendRequests() on nearly every route for the nav badge, and
 * useFriends() is cached alongside it, so rendering this next to fifty member rows costs nothing
 * extra. The cost is that it renders "Add friend" for a beat before the lists load — deliberate,
 * since the failure mode is a request that comes back "already sent", not a wrong action.
 */
export function FriendActionButton({
  userId,
  username,
  isBot,
  variant = "full",
}: {
  userId: string;
  username: string;
  isBot?: boolean;
  /** "full" — a labelled button (profile cards). "icon" — a square icon button (dense rows). */
  variant?: "full" | "icon";
}) {
  const me = useAuthStore((s) => s.user);
  const { data: friends } = useFriends();
  const { data: requests } = useFriendRequests();
  const send = useSendFriendRequest();
  const respond = useRespondToFriendRequest();

  // Bots can't be friended (friends/service.ts rejects it), and neither can you friend yourself.
  if (isBot || !me || userId === me.id) return null;

  const isFriend = friends?.some((f) => f.user.id === userId) ?? false;
  const incoming = requests?.incoming.find((r) => r.requester.id === userId);
  const outgoing = requests?.outgoing.find((r) => r.addressee.id === userId);

  const base =
    variant === "full"
      ? "flex w-full items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium"
      : "flex shrink-0 items-center justify-center rounded p-1.5";

  if (isFriend) {
    return (
      <span
        className={cn(base, "cursor-default text-signal-dim", variant === "full" && "bg-base-700")}
        title="You're already friends"
      >
        <UserCheck size={variant === "full" ? 15 : 16} />
        {variant === "full" && "Friends"}
      </span>
    );
  }

  if (incoming) {
    // They asked first. Accepting is one click here rather than a trip to the Friends page — the
    // request being mutual is the single strongest signal that this is the wanted action.
    return (
      <button
        onClick={() => respond.mutate({ requestId: incoming.id, accept: true })}
        disabled={respond.isPending}
        className={cn(base, "bg-online text-white hover:opacity-90 disabled:opacity-60")}
        title="Accept friend request"
        aria-label={`Accept friend request from ${username}`}
      >
        <Check size={variant === "full" ? 15 : 16} />
        {variant === "full" && "Accept friend request"}
      </button>
    );
  }

  if (outgoing) {
    return (
      <button
        onClick={() => respond.mutate({ requestId: outgoing.id, accept: false })}
        disabled={respond.isPending}
        className={cn(base, "text-signal-dim hover:text-dnd disabled:opacity-60", variant === "full" && "bg-base-700")}
        title="Cancel friend request"
        aria-label={`Cancel friend request to ${username}`}
      >
        <Clock size={variant === "full" ? 15 : 16} />
        {variant === "full" && "Request sent — cancel"}
      </button>
    );
  }

  return (
    <button
      onClick={async () => {
        try {
          const result = await send.mutateAsync(username);
          // sendFriendRequest auto-connects when a reverse request already existed, so the honest
          // confirmation depends on what actually happened rather than on what was asked for.
          toast.success(
            result.status === "ACCEPTED"
              ? `You and ${username} are now friends.`
              : `Friend request sent to ${username}.`,
          );
        } catch (e) {
          reportError(e, "Couldn't send that friend request.");
        }
      }}
      disabled={send.isPending}
      className={cn(
        base,
        variant === "full"
          ? "bg-base-700 text-signal hover:bg-base-500 disabled:opacity-60"
          : "text-signal-dim hover:bg-base-500 hover:text-signal disabled:opacity-60",
      )}
      title="Add friend"
      aria-label={`Send a friend request to ${username}`}
    >
      <UserPlus size={variant === "full" ? 15 : 16} />
      {variant === "full" && "Add friend"}
    </button>
  );
}
