import { usePreferencesStore } from "../../store/preferencesStore";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Pencil, Trash2, Reply, Check, X, Pin, PinOff, MessagesSquare, Flag, Forward, Mail, Bookmark, Link as LinkIcon, CornerUpLeft, LogIn, LogOut } from "lucide-react";
import { useSaveMessage } from "../../queries/keep";
import { useUIStore } from "../../store/uiStore";
import { useMarkChannelUnread } from "../../queries/readState";
import { BotBadge } from "../common/BotBadge";
import { OfficialBadge } from "../common/OfficialBadge";
import { StaffBadge } from "../common/StaffBadge";
import { PremiumBadge } from "../common/PremiumBadge";
import type { MessageDTO } from "@lumina/shared";
import { UserAvatar } from "../common/UserAvatar";
import { ServerProfileCard } from "../common/ServerProfileCard";
import { MessageContent, SpoilerAttachment, stripSpoilerPrefix } from "./MessageContent";
import { PollCard } from "./PollCard";
import { LinkEmbeds } from "./LinkEmbeds";
import { MessageComponents } from "./MessageComponents";
import { resolveAssetUrl, attachmentUrl } from "../../lib/apiClient";
import { useCustomEmojis } from "../../queries/emoji";
import { ReactionPicker } from "./ReactionPicker";
import { cn } from "../../lib/cn";
import { useConfirm } from "../common/ConfirmDialog";
import { Tooltip } from "../common/Tooltip";
import { useCreateDM } from "../../queries/dms";
import { reportError, toast } from "../../store/toastStore";
import { PUBLIC_ORIGIN } from "../../lib/platform";

function formatTime(iso: string, hour12 = true): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: hour12 ? "numeric" : "2-digit", minute: "2-digit", hour12 });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * One message, on a timeline.
 *
 * The old row was the shape every chat app copied from the same place: avatar on the left, name
 * and time sharing a baseline, body underneath, and a hover toolbar in a notch that overlapped the
 * message ABOVE it (so the buttons for one message appeared to belong to another). Three changes
 * make this the app's own:
 *
 *  - **A spine.** Rows in the same author group hang off a hairline dropped from the avatar, so a
 *    group reads as one block of speech instead of relying on the reader to notice a missing
 *    avatar. Your own messages tint theirs with the accent — presence without a bubble, which
 *    would read as SMS and halve the usable line length.
 *  - **Time in a right-hand gutter.** It aligns down the entire list and can be scanned as a
 *    column, instead of being a different distance from the left edge on every single line.
 *  - **Actions on the right edge**, in their own row, so they can never be mistaken for the
 *    previous message's.
 *
 * Everything else — editing in place, reactions, threads, polls, embeds, spoilers, webhook posts,
 * profile popovers — behaves exactly as before.
 */
export function MessageItem({
  message,
  showHeader,
  highlighted,
  canManage,
  currentUserId,
  onEdit,
  onDelete,
  onReply,
  onReact,
  onUnreact,
  onTogglePin,
  onOpenThread,
  onStartThread,
  onJumpToMessage,
}: {
  message: MessageDTO;
  showHeader: boolean;
  /** Briefly flashed after a jump-to-message — see MessageList. */
  highlighted?: boolean;
  canManage: boolean;
  currentUserId: string | undefined;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onReply: (message: MessageDTO) => void;
  onReact: (messageId: string, emoji: string) => void;
  onUnreact: (messageId: string, emoji: string) => void;
  onTogglePin?: (messageId: string, pinned: boolean) => void;
  /** Both absent in DMs — threads only exist inside server channels. */
  onOpenThread?: (threadId: string) => void;
  onStartThread?: (message: MessageDTO) => void;
  /** Scroll to and flash another message in this list. Absent where there is no list to
   * scroll — the thread panel renders items without one. */
  onJumpToMessage?: (messageId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  // Custom emoji are server-scoped, so they resolve from the route's server. In a DM there is no
  // serverId and the map is empty — `:name:` correctly stays literal text there.
  const { serverId } = useParams<{ serverId?: string }>();
  const { data: customEmojis } = useCustomEmojis(serverId);
  const emojiMap = useMemo(
    () => new Map((customEmojis ?? []).map((e) => [e.name, e.imageUrl])),
    [customEmojis],
  );
  const isOwn = message.authorId === currentUserId;
  const canEdit = isOwn;
  const canDelete = isOwn || canManage;
  const openReport = useUIStore((s) => s.openModalWith);
  const markUnread = useMarkChannelUnread();
  const save = useSaveMessage();
  const chatPrefs = usePreferencesStore((s) => s.prefs.chat);
  const author = message.author;
  const displayName = author?.displayName ?? author?.username ?? message.webhookUsername ?? "Unknown user";
  const avatarUrl = author?.avatarUrl ?? message.webhookAvatarUrl ?? null;
  const navigate = useNavigate();
  const createDM = useCreateDM();
  const { confirm } = useConfirm();

  // Deleting a message cannot be undone, and every other destructive action in the app asks
  // first. Shift-click skips the prompt, the same escape hatch the roster offers.
  async function confirmDelete(e: { shiftKey: boolean }) {
    if (
      e.shiftKey ||
      (await confirm({
        title: "Delete message?",
        description: "This can't be undone.",
        confirmText: "Delete",
        danger: true,
      }))
    ) {
      await onDelete(message.id);
    }
  }

  // Clicking a message author opens a real profile popover with a "Message" button inside for the
  // DM jump. Webhook posts (author === null) have no real user behind them, so they aren't
  // clickable at all.
  async function openAuthorDM() {
    if (!author) return;
    try {
      const convo = await createDM.mutateAsync({ participantIds: [author.id] });
      navigate(`/dm/${convo.id}`);
    } catch (e) {
      // A message can long outlive its author's account, so this is the call site most likely to
      // hold an id the server no longer recognises.
      reportError(e, "Couldn't open a conversation with them.");
    }
  }

  async function saveEdit() {
    if (draft.trim() && draft !== message.content) {
      await onEdit(message.id, draft.trim());
    }
    setEditing(false);
  }

  const iconBtn = "rounded-md p-1 text-signal-dim transition hover:bg-base-600 hover:text-signal";

  // A shareable deep link to this exact message. Channel links need the serverId from the route
  // (/channels/:serverId/:channelId); a DM link needs only the conversation. When neither can be
  // built (a channel message rendered without a serverId in the route), the button is omitted.
  const linkPath =
    message.channelId && serverId
      ? `/channels/${serverId}/${message.channelId}?message=${message.id}`
      : message.dmConversationId
        ? `/dm/${message.dmConversationId}?message=${message.id}`
        : null;

  async function copyMessageLink() {
    if (!linkPath) return;
    const url = `${PUBLIC_ORIGIN}${linkPath}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Message link copied");
    } catch {
      reportError(null, "Couldn't copy the link");
    }
  }

  if (message.type === "MEMBER_JOIN" || message.type === "MEMBER_LEAVE") {
    return <SystemMessage message={message} highlighted={highlighted} displayName={displayName} avatarUrl={avatarUrl} />;
  }

  return (
    <div
      className={cn(
        "lx-msg group",
        showHeader && "lx-msg--head",
        isOwn && "lx-msg--own",
        highlighted && "rounded-lg bg-accent/10 transition-colors duration-500",
      )}
      data-message-id={message.id}
    >
      <span className="lx-spine" aria-hidden="true" />

      {/* Avatar column. Only the first row of a group carries a face; the rest lean on the spine. */}
      <div className="relative z-[1] flex justify-end">
        {showHeader ? (
          author ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="rounded-lg" aria-label={`${displayName}'s profile`}>
                  <UserAvatar avatarUrl={avatarUrl} name={displayName} size={34} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" className="z-50">
                  <ServerProfileCard user={author} serverId={serverId} onMessage={!isOwn ? () => void openAuthorDM() : undefined} />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <UserAvatar avatarUrl={avatarUrl} name={displayName} size={34} />
          )
        ) : null}
      </div>

      <div className="min-w-0">
        {/* The line a reply is answering. Above the header, so it reads top to bottom: this
            is what was said, and this is the answer. Truncated to one line on purpose — it is
            a pointer to the parent, not a copy of it. */}
        {message.replyTo ? (
          <button
            type="button"
            onClick={() => onJumpToMessage?.(message.replyTo!.id)}
            disabled={!onJumpToMessage}
            className="mb-0.5 flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-signal-dim enabled:hover:text-signal"
          >
            <CornerUpLeft size={11} className="shrink-0 text-signal-faint" aria-hidden="true" />
            <span className="shrink-0 font-medium text-signal-faint">
              {message.replyTo.author?.displayName ?? message.replyTo.author?.username ?? "Unknown"}
            </span>
            <span className="min-w-0 truncate">
              {message.replyTo.deleted
                ? "message deleted"
                : message.replyTo.content ||
                  (message.replyTo.hasAttachments ? "sent an attachment" : "sent a message")}
            </span>
          </button>
        ) : null}

        {showHeader && (
          <div className="mb-0.5 flex items-baseline gap-1.5">
            {author ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="truncate text-sm font-semibold text-signal hover:underline">{displayName}</button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="start" className="z-50">
                    <ServerProfileCard user={author} serverId={serverId} onMessage={!isOwn ? () => void openAuthorDM() : undefined} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <span className="truncate text-sm font-semibold text-signal">{displayName}</span>
            )}
            {author?.isOfficial ? <OfficialBadge compact /> : null}
            {!author?.isOfficial && author?.isStaff ? <StaffBadge compact /> : null}
            {author?.isPremium ? <PremiumBadge compact /> : null}
            {author?.isBot ? <BotBadge /> : null}
            {!author && message.webhookId ? <BotBadge label="Webhook" /> : null}
            {message.editedAt ? <span className="font-mono text-[9px] text-signal-faint">edited</span> : null}
            {message.pinned ? (
              <span className="flex items-center gap-0.5 font-mono text-[9px] text-signal-faint">
                <Pin size={9} /> pinned
              </span>
            ) : null}
          </div>
        )}

        {editing ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              aria-label="Edit this message"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(message.content);
                }
              }}
              className="w-full rounded-lg border border-accent bg-base-900/60 px-2.5 py-1.5 text-sm text-signal outline-none"
              rows={2}
            />
            <div className="flex gap-3 text-xs text-signal-dim">
              <button onClick={() => void saveEdit()} className="flex items-center gap-1 text-online hover:underline">
                <Check size={12} /> Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
                className="flex items-center gap-1 hover:underline"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.content ? (
              <MessageContent
                content={message.content}
                emojiMap={emojiMap}
                className="lx-body prose-invert break-words text-sm leading-relaxed text-signal [&_.mention]:rounded [&_.mention]:bg-accent/30 [&_.mention]:px-1 [&_.mention]:text-accent [&_.mention-everyone]:bg-idle/30 [&_.mention-everyone]:text-idle [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-base-900 [&_code]:px-1 [&_code]:py-0.5"
              />
            ) : null}
            {message.attachments.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-2">
                {message.attachments.map((a) => (
                  <SpoilerAttachment key={a.id} fileName={a.fileName}>
                    {chatPrefs.showMedia && a.mimeType.startsWith("image/") ? (
                      <img
                        src={attachmentUrl(a.url)}
                        alt={stripSpoilerPrefix(a.fileName)}
                        className="max-h-80 max-w-sm rounded-xl border border-hairline"
                      />
                    ) : chatPrefs.showMedia && a.mimeType.startsWith("video/") ? (
                      <video
                        src={attachmentUrl(a.url)}
                        controls
                        preload="metadata"
                        className="max-h-80 max-w-sm rounded-xl border border-hairline"
                      />
                    ) : chatPrefs.showMedia && a.mimeType.startsWith("audio/") ? (
                      <audio src={attachmentUrl(a.url)} controls preload="metadata" className="max-w-xs" />
                    ) : (
                      <a
                        href={attachmentUrl(a.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-fit items-center gap-2 rounded-lg border border-hairline bg-base-900/50 px-3 py-2 text-sm text-accent underline"
                      >
                        {stripSpoilerPrefix(a.fileName)}
                      </a>
                    )}
                  </SpoilerAttachment>
                ))}
              </div>
            )}
            {message.sticker ? (
              <img
                src={resolveAssetUrl(message.sticker.imageUrl)}
                alt={message.sticker.name}
                title={message.sticker.description ?? message.sticker.name}
                // Fixed box rather than intrinsic size: stickers are normalised to 320px square on
                // upload, and letting one render at its full size next to a line of text would make
                // it the loudest thing in the room.
                className="mt-1 h-40 w-40 object-contain"
                draggable={false}
              />
            ) : null}
            {message.poll ? <PollCard poll={message.poll} currentUserId={currentUserId} /> : null}
            {chatPrefs.showLinkPreviews ? <LinkEmbeds embeds={message.embeds} /> : null}
            {message.components ? <MessageComponents messageId={message.id} rows={message.components} /> : null}
          </>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => (r.reactedByMe ? onUnreact(message.id, r.emoji) : onReact(message.id, r.emoji))}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition",
                  r.reactedByMe
                    ? "border-accent bg-accent/20 text-accent"
                    : "border-hairline bg-base-900/40 text-signal-dim hover:border-signal-faint hover:text-signal",
                )}
              >
                {(() => {
                  // A custom-emoji reaction is stored as its `:name:` token; resolve it against the
                  // same map the message body uses so the pill shows the emoji rather than the
                  // literal text. Unicode and unknown tokens fall through unchanged.
                  const custom =
                    r.emoji.startsWith(":") && r.emoji.endsWith(":") ? emojiMap.get(r.emoji.slice(1, -1)) : undefined;
                  return custom ? (
                    <img src={resolveAssetUrl(custom)} alt={r.emoji} className="h-4 w-4 object-contain" />
                  ) : (
                    <span>{r.emoji}</span>
                  );
                })()}
                <span className="font-mono text-[10px]">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {message.thread && (
          <button
            onClick={() => onOpenThread?.(message.thread!.id)}
            className="mt-2 flex items-center gap-2 rounded-lg border border-hairline bg-base-900/40 px-2.5 py-1.5 text-left text-xs transition hover:border-accent"
          >
            <MessagesSquare size={13} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate font-medium text-signal">{message.thread.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-signal-faint">
              {message.thread.messageCount === 1 ? "1 reply" : `${message.thread.messageCount} replies`}
              {message.thread.archived ? " · archived" : ""}
            </span>
          </button>
        )}
      </div>

      {/* Right-hand time gutter. Always shown on a group's first row, on hover for the rest — so a
          group's opening time is permanent context and the individual times are there when wanted
          without printing a clock beside every line. */}
      <div className="lx-gutter" title={formatFullDate(message.createdAt)}>
        {formatTime(message.createdAt, !chatPrefs.use24hClock)}
      </div>

      {!editing && (
        <div className="lx-msg-actions">
          <ReactionPicker onPick={(emoji) => onReact(message.id, emoji)} />
          <Tooltip content="Reply">
            <button onClick={() => onReply(message)} className={iconBtn} aria-label="Reply">
              <Reply size={15} />
            </button>
          </Tooltip>
          <Tooltip content="Save this">
            <button
              onClick={() => save.mutate({ messageId: message.id })}
              className={iconBtn}
              aria-label="Save this message"
            >
              <Bookmark size={15} />
            </button>
          </Tooltip>
          <Tooltip content="Forward">
            <button
              onClick={() =>
                openReport("forward", {
                  content: message.content,
                  authorLabel: displayName,
                  attachmentCount: message.attachments.length,
                })
              }
              className={iconBtn}
              aria-label="Forward message"
            >
              <Forward size={15} />
            </button>
          </Tooltip>
          {message.channelId && (
            <Tooltip content="Mark unread">
              <button
                onClick={() => markUnread.mutate({ channelId: message.channelId!, messageId: message.id })}
                className={iconBtn}
                aria-label="Mark unread from here"
              >
                <Mail size={15} />
              </button>
            </Tooltip>
          )}
          {linkPath && (
            <Tooltip content="Copy message link">
              <button onClick={() => void copyMessageLink()} className={iconBtn} aria-label="Copy message link">
                <LinkIcon size={15} />
              </button>
            </Tooltip>
          )}
          {onStartThread && message.channelId && (
            <Tooltip content={message.thread ? "Open thread" : "Start a thread"}>
              <button
                onClick={() => (message.thread ? onOpenThread?.(message.thread.id) : onStartThread(message))}
                className={iconBtn}
                aria-label={message.thread ? "Open thread" : "Start a thread"}
              >
                <MessagesSquare size={15} />
              </button>
            </Tooltip>
          )}
          {onTogglePin && canManage && message.channelId && (
            <Tooltip content={message.pinned ? "Unpin" : "Pin"}>
              <button
                onClick={() => onTogglePin(message.id, !message.pinned)}
                className={iconBtn}
                aria-label={message.pinned ? "Unpin" : "Pin"}
              >
                {message.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              </button>
            </Tooltip>
          )}
          {!isOwn && (
            <Tooltip content="Report message">
              <button
                onClick={() => openReport("report", { targetType: "MESSAGE", targetId: message.id, label: displayName })}
                className={iconBtn}
                aria-label="Report message"
              >
                <Flag size={15} />
              </button>
            </Tooltip>
          )}
          {canEdit && (
            <Tooltip content="Edit">
              <button
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
                className={iconBtn}
                aria-label="Edit"
              >
                <Pencil size={15} />
              </button>
            </Tooltip>
          )}
          {canDelete && (
            <Tooltip content="Delete (shift-click to skip the confirm)">
              <button
                onClick={(e) => void confirmDelete(e)}
                className="rounded-md p-1 text-signal-dim transition hover:bg-base-600 hover:text-flare"
                aria-label="Delete"
              >
                <Trash2 size={15} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A join/leave announcement. Not a chat bubble: no spine, no reply/react/edit controls — it is
 * the space speaking about a member, so it reads as one quiet line with the member's face on it.
 * The `@username` inside is the same mention the composer would produce, so it is tappable in
 * spirit and styled like one here.
 */
function SystemMessage({
  message,
  highlighted,
  displayName,
  avatarUrl,
}: {
  message: MessageDTO;
  highlighted?: boolean;
  displayName: string;
  avatarUrl: string | null;
}) {
  const joined = message.type === "MEMBER_JOIN";
  const parts = message.content.split(/(@[a-zA-Z0-9_]+)/g);
  const chatPrefs = usePreferencesStore((s) => s.prefs.chat);
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-1.5", highlighted && "rounded-lg bg-accent/10 transition-colors duration-500")}
      data-message-id={message.id}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          joined ? "bg-online/15 text-online" : "bg-base-600 text-signal-faint",
        )}
      >
        {joined ? <LogIn size={13} /> : <LogOut size={13} />}
      </span>
      <UserAvatar avatarUrl={avatarUrl} name={displayName} size={20} />
      <span className="min-w-0 flex-1 truncate text-sm text-signal-dim">
        {parts.map((part, i) =>
          part.startsWith("@") ? (
            <span key={i} className="font-medium text-accent">
              {part}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </span>
      <time className="shrink-0 text-[11px] text-signal-faint" dateTime={message.createdAt} title={formatFullDate(message.createdAt)}>
        {formatTime(message.createdAt, !chatPrefs.use24hClock)}
      </time>
    </div>
  );
}
