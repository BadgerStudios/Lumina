import { MessageCircle, UserMinus, Ban, ShieldCheck, Copy, Flag } from "lucide-react";
import type { UserDTO, RoleDTO, MemberDTO } from "@lumina/shared";
import { UserAvatar } from "./UserAvatar";
import { BotBadge } from "./BotBadge";
import { OfficialBadge } from "./OfficialBadge";
import { PremiumBadge } from "./PremiumBadge";
import { FriendActionButton } from "./FriendActionButton";
import { resolveAssetUrl } from "../../lib/apiClient";
import { shortDate } from "../../lib/relativeTime";
import {
  useFriends,
  useRemoveFriend,
  useBlockUser,
  useUnblockUser,
  useBlockedUsers,
} from "../../queries/friends";
import { useAuthStore } from "../../store/authStore";
import { toast } from "../../store/toastStore";
import { useUIStore } from "../../store/uiStore";

/** Discord-style profile card — shown in a popover from clicking a name/avatar anywhere (member
 * list, messages). Was a real gap: bio/pronouns/banner (see UserSettingsModal.tsx's
 * AccountSection) were fully editable but had NO surface anywhere else in the app to actually
 * see them on another user. `user` already carries these fields on every UserDTO — no extra
 * fetch needed, they ride along on whatever already loaded the member/message.
 *
 * The action set was also a gap: block, unblock, remove-friend and report all existed in the
 * backend + the friends hooks but were reachable ONLY from the dedicated Friends page. Since this
 * one card is the popover for the member list, message avatars AND message author names, adding
 * them here surfaces them on every one of those surfaces at once. */
function colorToCss(color: number | null | undefined): string | undefined {
  if (color === null || color === undefined) return undefined;
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function UserProfileCard({
  user,
  nickname,
  onMessage,
  roles,
  member,
}: {
  user: UserDTO;
  nickname?: string | null;
  onMessage?: () => void;
  /** Roles to consider for the chips: either this person's already-resolved roles, or the whole
   * server role list, in which case `member.roleIds` picks out the ones that are theirs. */
  roles?: RoleDTO[];
  /** The server membership — supplies "member since" and, with `roles`, which roles are theirs.
   * Both stay optional so the plain DM popover, which has no server context, is unchanged. */
  member?: MemberDTO;
}) {
  const displayName = nickname ?? user.displayName ?? user.username;
  const me = useAuthStore((s) => s.user);

  // Relationship actions only make sense for other real people — never yourself, never a bot
  // (friends/service.ts + blockUser reject both). Copy-ID stays available for everyone.
  const canRelate = !!me && user.id !== me.id && !user.isBot;

  const { data: friends } = useFriends();
  const { data: blocked } = useBlockedUsers(canRelate);
  const removeFriend = useRemoveFriend();
  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const openReport = useUIStore((st) => st.openModalWith);

  const isFriend = friends?.some((f) => f.user.id === user.id) ?? false;
  const isBlocked = blocked?.some((b) => b.user.id === user.id) ?? false;

  // With `member` present, `roles` is narrowed to what this person holds; without it, `roles` is
  // taken as already scoped to them. @everyone never makes a useful chip, and the order matches
  // the roster: highest first.
  const roleChips = (roles ?? [])
    .filter((r) => !r.isDefault && (!member || member.roleIds.includes(r.id)))
    .sort((a, b) => b.position - a.position);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      toast.success("User ID copied.");
    } catch {
      toast.error("Couldn't copy the ID.");
    }
  };

  const secondaryBtn =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-signal-dim hover:bg-base-700 hover:text-signal disabled:opacity-60";
  const dangerBtn =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-signal-dim hover:bg-dnd/15 hover:text-dnd disabled:opacity-60";

  return (
    <div className="w-72 overflow-hidden rounded-lg bg-base-600 shadow-lg">
      <div
        className="aspect-[3/1] w-full bg-base-900"
        style={
          user.bannerUrl
            ? { backgroundImage: `url(${resolveAssetUrl(user.bannerUrl)})`, backgroundSize: "cover", backgroundPosition: "center" }
            : undefined
        }
      />
      <div className="px-3 pb-3">
        <div className="-mt-8 mb-2">
          <UserAvatar avatarUrl={user.avatarUrl} name={displayName} size={64} presence={user.presence} />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="truncate text-base font-bold text-signal">{displayName}</span>
          {user.isOfficial ? <OfficialBadge /> : null}
          {user.isPremium ? <PremiumBadge /> : null}
          {user.isBot ? <BotBadge /> : null}
        </div>
        <div className="truncate text-sm text-signal-dim">@{user.username}</div>
        {nickname && nickname !== (user.displayName ?? user.username) ? (
          <div className="mt-0.5 truncate text-xs text-signal-faint">{user.displayName ?? user.username}</div>
        ) : null}

        {user.pronouns ? <div className="mt-2 text-xs font-medium text-signal-dim">{user.pronouns}</div> : null}

        {user.bio ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <p className="whitespace-pre-wrap text-sm text-signal">{user.bio}</p>
          </div>
        ) : null}

        {user.statusText || user.statusEmoji ? (
          <div className="mt-2 flex items-start gap-1.5 border-t border-base-900/60 pt-2 text-sm italic text-signal-dim">
            {user.statusEmoji ? <span className="not-italic leading-none">{user.statusEmoji}</span> : null}
            {user.statusText ? <span>{user.statusText}</span> : null}
          </div>
        ) : null}

        {roleChips.length > 0 ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <div className="lx-eyebrow mb-1 text-signal-faint">Roles</div>
            <div className="flex flex-wrap gap-1">
              {roleChips.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded-row border border-hairline bg-base-700 px-1.5 py-0.5 text-micro font-medium text-signal-dim"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: colorToCss(r.color) ?? "var(--signal-faint)" }}
                  />
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {member?.joinedAt ? (
          <div className="mt-2 text-xs text-signal-faint">Member since {shortDate(member.joinedAt)}</div>
        ) : null}

        <div className="mt-3 flex flex-col gap-1.5">
          {onMessage && (
            <button
              onClick={onMessage}
              className="flex w-full items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              <MessageCircle size={15} /> Message
            </button>
          )}
          {/* The card showed who someone was and let you message them, but gave no way to add
              them — the one action a profile popover most obviously exists for. */}
          <FriendActionButton userId={user.id} username={user.username} isBot={user.isBot} />
        </div>

        {/* Secondary actions: the ones that used to live only on the Friends page. */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-base-900/60 pt-2">
            {canRelate && isFriend && (
              <button
                className={dangerBtn}
                disabled={removeFriend.isPending}
                onClick={() => {
                  if (confirm(`Remove ${displayName} as a friend?`)) removeFriend.mutate(user.id);
                }}
              >
                <UserMinus size={15} /> Remove friend
              </button>
            )}
            {canRelate &&
              (isBlocked ? (
                <button
                  className={secondaryBtn}
                  disabled={unblockUser.isPending}
                  onClick={() => unblockUser.mutate(user.id)}
                >
                  <ShieldCheck size={15} /> Unblock
                </button>
              ) : (
                <button
                  className={dangerBtn}
                  disabled={blockUser.isPending}
                  onClick={() => {
                    if (confirm(`Block ${displayName}? They won't be able to message you or send a friend request, and you'll no longer see each other.`))
                      blockUser.mutate(user.username);
                  }}
                >
                  <Ban size={15} /> Block
                </button>
              ))}
            {canRelate && (
              <button
                className={dangerBtn}
                onClick={() => openReport("report", { targetType: "USER", targetId: user.id, label: displayName })}
              >
                <Flag size={15} /> Report
              </button>
            )}
            <button className={secondaryBtn} onClick={copyId}>
              <Copy size={15} /> Copy user ID
            </button>
        </div>
      </div>
    </div>
  );
}
