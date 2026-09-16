import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, UserMinus, Ban, ShieldCheck, Copy, Flag, Phone, Plus, X, Volume2, AtSign } from "lucide-react";
import type { UserDTO, RoleDTO, MemberDTO } from "@lumina/shared";
import { UserAvatar } from "./UserAvatar";
import { BotBadge } from "./BotBadge";
import { OfficialBadge } from "./OfficialBadge";
import { StaffBadge, StaffNotice } from "./StaffBadge";
import { PremiumBadge } from "./PremiumBadge";
import { FriendActionButton } from "./FriendActionButton";
import { api, resolveAssetUrl } from "../../lib/apiClient";
import { shortDate } from "../../lib/relativeTime";
import {
  useFriends,
  useRemoveFriend,
  useBlockUser,
  useUnblockUser,
  useBlockedUsers,
} from "../../queries/friends";
import { useUserNote, useSetUserNote } from "../../queries/keep";
import { useUserProfileExtras } from "../../queries/users";
import { useCreateDM } from "../../queries/dms";
import { useAuthStore } from "../../store/authStore";
import { reportError, toast } from "../../store/toastStore";
import { useUIStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";

/** Discord-style profile card — shown in a popover from clicking a name/avatar anywhere (member
 * list, messages, a DM header). Everything a person usually reaches for from a profile lives here:
 * who they are (bio, pronouns, status, badges, how long they have been on Lumina and in this
 * space), what you share (mutual spaces and friends), your private note about them, and the
 * actions — message (inline or in the DM), call, friend, block, report, copy — plus the two that
 * depend on context: role editing for people allowed to manage roles, and a volume slider while you
 * are in a voice call together. */
function colorToCss(color: number | null | undefined): string | undefined {
  if (color === null || color === undefined) return undefined;
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Role editing handed in by the caller that knows the viewer's permissions (ServerProfileCard). */
export interface RoleManagement {
  /** Roles the viewer may add or remove — below their own highest role, never @everyone. */
  assignable: RoleDTO[];
  onAdd: (roleId: string) => void;
  onRemove: (roleId: string) => void;
  pending?: boolean;
}

export function UserProfileCard({
  user,
  nickname,
  onMessage,
  roles,
  member,
  manageRoles,
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
  manageRoles?: RoleManagement;
}) {
  const displayName = nickname ?? user.displayName ?? user.username;
  const me = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const isSelf = !!me && me.id === user.id;

  // Relationship actions only make sense for other real people — never yourself, never a bot
  // (friends/service.ts + blockUser reject both). Copy-ID stays available for everyone.
  const canRelate = !!me && user.id !== me.id && !user.isBot;

  const { data: friends } = useFriends();
  const { data: blocked } = useBlockedUsers(canRelate);
  const removeFriend = useRemoveFriend();
  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const openReport = useUIStore((st) => st.openModalWith);
  const { data: extras } = useUserProfileExtras(user.id);
  const { data: noteData } = useUserNote(isSelf ? null : user.id);
  const setNote = useSetUserNote();
  const createDM = useCreateDM();
  const startCall = useVoiceStore((s) => s.startCall);
  const inVoiceTogether = useVoiceStore((s) => Object.values(s.participants).some((p) => p.userId === user.id));
  const volume = useVoiceStore((s) => s.userVolumes[user.id] ?? 100);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);

  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [sending, setSending] = useState(false);
  const [pickingRole, setPickingRole] = useState(false);

  const isFriend = friends?.some((f) => f.user.id === user.id) ?? false;
  const isBlocked = blocked?.some((b) => b.user.id === user.id) ?? false;
  const canContact = canRelate && !isBlocked;

  // With `member` present, `roles` is narrowed to what this person holds; without it, `roles` is
  // taken as already scoped to them. @everyone never makes a useful chip, and the order matches
  // the roster: highest first.
  const roleChips = (roles ?? [])
    .filter((r) => !r.isDefault && (!member || member.roleIds.includes(r.id)))
    .sort((a, b) => b.position - a.position);
  const assignableIds = new Set((manageRoles?.assignable ?? []).map((r) => r.id));
  const addable = (manageRoles?.assignable ?? []).filter((r) => !member?.roleIds.includes(r.id));

  const noteValue = noteDraft ?? noteData?.note?.body ?? "";

  // The card sits inside a Radix menu, whose typeahead moves focus to a matching item on every
  // printable key. Typing in the note or the message box would jump focus away mid-word.
  const keepKeys = (e: KeyboardEvent) => e.stopPropagation();

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch {
      toast.error(`Couldn't copy the ${what.toLowerCase()}.`);
    }
  };

  async function openConversation(): Promise<string | null> {
    try {
      const convo = await createDM.mutateAsync({ participantIds: [user.id] });
      return convo.id;
    } catch (e) {
      reportError(e, "Couldn't open a conversation with them.");
      return null;
    }
  }

  async function sendQuick() {
    const text = quick.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const id = await openConversation();
      if (!id) return;
      await api.post(`/dm/${id}/messages`, { content: text });
      setQuick("");
      toast.success(`Sent to ${displayName}.`);
    } catch (e) {
      reportError(e, "Couldn't send that.");
    } finally {
      setSending(false);
    }
  }

  async function call() {
    const id = await openConversation();
    if (!id) return;
    navigate(`/dm/${id}`);
    void startCall(id);
  }

  function saveNote() {
    if (noteDraft === null || isSelf) return;
    const body = noteDraft.trim();
    if (body !== (noteData?.note?.body ?? "")) setNote.mutate({ userId: user.id, body });
    setNoteDraft(null);
  }

  const secondaryBtn =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-signal-dim hover:bg-base-700 hover:text-signal disabled:opacity-60";
  const dangerBtn =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-signal-dim hover:bg-dnd/15 hover:text-dnd disabled:opacity-60";
  const sectionTitle = "lx-eyebrow mb-1 text-signal-faint";

  const mutualServers = extras?.mutualServers ?? [];
  const mutualFriends = extras?.mutualFriends ?? [];

  return (
    <div className="max-h-[80vh] w-80 overflow-y-auto overscroll-contain rounded-lg bg-base-600 shadow-lg">
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
          {!user.isOfficial && user.isStaff ? <StaffBadge /> : null}
          {user.isPremium ? <PremiumBadge /> : null}
          {user.isBot ? <BotBadge /> : null}
        </div>
        <div className="truncate text-sm text-signal-dim">
          @{user.username}
          {user.pronouns ? <span className="text-signal-faint"> · {user.pronouns}</span> : null}
        </div>
        {nickname && nickname !== (user.displayName ?? user.username) ? (
          <div className="mt-0.5 truncate text-xs text-signal-faint">{user.displayName ?? user.username}</div>
        ) : null}

        {!user.isOfficial && user.isStaff ? (
          <div className="mt-2">
            <StaffNotice />
          </div>
        ) : null}

        {user.statusText || user.statusEmoji ? (
          <div className="mt-2 flex items-start gap-1.5 rounded bg-base-700 px-2 py-1.5 text-sm text-signal-dim">
            {user.statusEmoji ? <span className="leading-none">{user.statusEmoji}</span> : null}
            {user.statusText ? <span className="min-w-0 break-words">{user.statusText}</span> : null}
          </div>
        ) : null}

        {user.bio ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <div className={sectionTitle}>About me</div>
            <p className="whitespace-pre-wrap break-words text-sm text-signal">{user.bio}</p>
          </div>
        ) : null}

        {extras?.createdAt || member?.joinedAt ? (
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-base-900/60 pt-2">
            {extras?.createdAt ? (
              <div>
                <div className={sectionTitle}>On Lumina since</div>
                <div className="text-xs text-signal-dim">{shortDate(extras.createdAt)}</div>
              </div>
            ) : null}
            {member?.joinedAt ? (
              <div>
                <div className={sectionTitle}>In this space since</div>
                <div className="text-xs text-signal-dim">{shortDate(member.joinedAt)}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        {roleChips.length > 0 || (manageRoles && member) ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <div className={sectionTitle}>Roles</div>
            <div className="flex flex-wrap gap-1">
              {roleChips.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded-row border border-hairline bg-base-700 px-1.5 py-0.5 text-micro font-medium text-signal-dim"
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: colorToCss(r.color) ?? "var(--signal-faint)" }} />
                  {r.name}
                  {manageRoles && assignableIds.has(r.id) ? (
                    <button
                      type="button"
                      aria-label={`Remove ${r.name}`}
                      disabled={manageRoles.pending}
                      onClick={() => manageRoles.onRemove(r.id)}
                      className="rounded text-signal-faint hover:text-dnd disabled:opacity-50"
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </span>
              ))}
              {manageRoles && member && addable.length > 0 ? (
                <button
                  type="button"
                  aria-label="Add a role"
                  onClick={() => setPickingRole((v) => !v)}
                  className="inline-flex items-center rounded-row border border-dashed border-hairline px-1.5 py-0.5 text-micro text-signal-faint hover:text-signal"
                >
                  <Plus size={11} />
                </button>
              ) : null}
            </div>
            {pickingRole && manageRoles ? (
              <div className="mt-1.5 flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded border border-hairline bg-base-700 p-1">
                {addable.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    disabled={manageRoles.pending}
                    onClick={() => {
                      manageRoles.onAdd(r.id);
                      setPickingRole(false);
                    }}
                    className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-signal-dim hover:bg-base-600 hover:text-signal"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: colorToCss(r.color) ?? "var(--signal-faint)" }} />
                    {r.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {!isSelf && (mutualServers.length > 0 || mutualFriends.length > 0) ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            {mutualServers.length > 0 ? (
              <>
                <div className={sectionTitle}>
                  {mutualServers.length} mutual space{mutualServers.length === 1 ? "" : "s"}
                </div>
                <div className="mb-1.5 flex flex-col gap-0.5">
                  {mutualServers.slice(0, 5).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => navigate(`/channels/${s.id}`)}
                      className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-signal-dim hover:bg-base-700 hover:text-signal"
                    >
                      <UserAvatar avatarUrl={s.iconUrl} name={s.name} size={18} />
                      <span className="truncate">{s.name}</span>
                    </button>
                  ))}
                  {mutualServers.length > 5 ? (
                    <span className="px-1 text-micro text-signal-faint">and {mutualServers.length - 5} more</span>
                  ) : null}
                </div>
              </>
            ) : null}
            {mutualFriends.length > 0 ? (
              <>
                <div className={sectionTitle}>
                  {mutualFriends.length} mutual friend{mutualFriends.length === 1 ? "" : "s"}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {mutualFriends.slice(0, 8).map((f) => (
                    <span key={f.id} className="inline-flex items-center gap-1 text-xs text-signal-dim" title={`@${f.username}`}>
                      <UserAvatar avatarUrl={f.avatarUrl} name={f.displayName ?? f.username} size={18} />
                      <span className="max-w-[6rem] truncate">{f.displayName ?? f.username}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {!isSelf ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <label className={sectionTitle} htmlFor={`note-${user.id}`}>
              Note
            </label>
            <textarea
              id={`note-${user.id}`}
              value={noteValue}
              placeholder="Only you can see this"
              maxLength={1000}
              rows={noteValue ? 2 : 1}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={saveNote}
              onKeyDown={keepKeys}
              className="w-full resize-none rounded bg-transparent px-1 py-0.5 text-xs text-signal placeholder:text-signal-faint hover:bg-base-700 focus:bg-base-700 focus:outline-none"
            />
          </div>
        ) : null}

        {inVoiceTogether && !isSelf ? (
          <div className="mt-2 border-t border-base-900/60 pt-2">
            <label className={`${sectionTitle} flex items-center gap-1`} htmlFor={`vol-${user.id}`}>
              <Volume2 size={12} /> Voice volume · {volume}%
            </label>
            <input
              id={`vol-${user.id}`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={volume}
              onChange={(e) => setUserVolume(user.id, Number(e.target.value))}
              onKeyDown={keepKeys}
              className="w-full accent-accent"
            />
          </div>
        ) : null}

        <div className="mt-3 flex flex-col gap-1.5">
          {onMessage || canContact ? (
            <div className="flex gap-1.5">
              {onMessage && (
                <button
                  onClick={onMessage}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  <MessageCircle size={15} /> Message
                </button>
              )}
              {canContact && (
                <button
                  onClick={() => void call()}
                  disabled={createDM.isPending}
                  aria-label={`Call ${displayName}`}
                  className="flex items-center justify-center gap-1.5 rounded bg-base-700 px-3 py-1.5 text-sm font-medium text-signal hover:bg-base-500 disabled:opacity-60"
                >
                  <Phone size={15} /> Call
                </button>
              )}
            </div>
          ) : null}
          {/* The card showed who someone was and let you message them, but gave no way to add
              them — the one action a profile popover most obviously exists for. */}
          <FriendActionButton userId={user.id} username={user.username} isBot={user.isBot} />
          {canContact ? (
            <input
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendQuick();
                }
              }}
              disabled={sending}
              maxLength={2000}
              placeholder={`Message @${user.username}`}
              aria-label={`Message @${user.username}`}
              className="w-full rounded bg-base-900 px-2 py-1.5 text-sm text-signal placeholder:text-signal-faint focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            />
          ) : null}
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
              <button className={secondaryBtn} disabled={unblockUser.isPending} onClick={() => unblockUser.mutate(user.id)}>
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
            <button className={dangerBtn} onClick={() => openReport("report", { targetType: "USER", targetId: user.id, label: displayName })}>
              <Flag size={15} /> Report
            </button>
          )}
          <button className={secondaryBtn} onClick={() => void copy(`@${user.username}`, "Username")}>
            <AtSign size={15} /> Copy username
          </button>
          <button className={secondaryBtn} onClick={() => void copy(user.id, "User ID")}>
            <Copy size={15} /> Copy user ID
          </button>
        </div>
      </div>
    </div>
  );
}
