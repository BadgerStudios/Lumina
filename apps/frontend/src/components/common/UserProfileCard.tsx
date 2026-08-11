import { MessageCircle } from "lucide-react";
import type { UserDTO } from "@lumina/shared";
import { UserAvatar } from "./UserAvatar";
import { BotBadge } from "./BotBadge";
import { OfficialBadge } from "./OfficialBadge";
import { FriendActionButton } from "./FriendActionButton";
import { resolveAssetUrl } from "../../lib/apiClient";

/** Discord-style profile card — shown in a popover from clicking a name/avatar anywhere (member
 * list, messages). Was a real gap: bio/pronouns/banner (see UserSettingsModal.tsx's
 * AccountSection) were fully editable but had NO surface anywhere else in the app to actually
 * see them on another user. `user` already carries these fields on every UserDTO — no extra
 * fetch needed, they ride along on whatever already loaded the member/message. */
export function UserProfileCard({
  user,
  nickname,
  onMessage,
}: {
  user: UserDTO;
  nickname?: string | null;
  onMessage?: () => void;
}) {
  const displayName = nickname ?? user.displayName ?? user.username;

  return (
    <div className="w-72 overflow-hidden rounded-lg bg-base-600 shadow-lg">
      <div
        className="h-16 w-full bg-base-900"
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

        {user.statusText ? (
          <div className="mt-2 border-t border-base-900/60 pt-2 text-sm italic text-signal-dim">{user.statusText}</div>
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
      </div>
    </div>
  );
}
