import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Pencil, Trash2, Reply, Check, X, Pin, PinOff, MessagesSquare } from "lucide-react";
import { BotBadge } from "../common/BotBadge";
import { OfficialBadge } from "../common/OfficialBadge";
import type { MessageDTO } from "@lumina/shared";
import { UserAvatar } from "../common/UserAvatar";
import { UserProfileCard } from "../common/UserProfileCard";
import { MessageContent, SpoilerAttachment, stripSpoilerPrefix } from "./MessageContent";
import { PollCard } from "./PollCard";
import { LinkEmbeds } from "./LinkEmbeds";
import { MessageComponents } from "./MessageComponents";
import { resolveAssetUrl } from "../../lib/apiClient";
import { useCustomEmojis } from "../../queries/emoji";
import { useParams } from "react-router-dom";
import { useMemo } from "react";
import { ReactionPicker } from "./ReactionPicker";
import { cn } from "../../lib/cn";
import { attachmentUrl } from "../../lib/apiClient";
import { useCreateDM } from "../../queries/dms";
import { reportError } from "../../store/toastStore";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function MessageItem({
  message,
  showHeader,
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
}: {
  message: MessageDTO;
  showHeader: boolean;
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
  const author = message.author;
  const displayName = author?.displayName ?? author?.username ?? message.webhookUsername ?? "Unknown user";
  const avatarUrl = author?.avatarUrl ?? message.webhookAvatarUrl ?? null;
  const navigate = useNavigate();
  const createDM = useCreateDM();
  // Clicking a message author previously did nothing, then (earlier this session) jumped
  // straight to a DM — upgraded to a real profile popover (see UserProfileCard.tsx) with a
  // "Message" button inside for the DM jump, same upgrade as MemberList.tsx's rows. Webhook
  // posts (author === null) have no real user behind them, so they're not clickable at all.
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

  return (
    <div className={cn("group relative flex gap-3 px-3 py-0.5 md:py-2.5 hover:bg-base-700/40", showHeader && "mt-3 pt-1.5")}>
      <div className="w-10 shrink-0">
        {showHeader ? (
          author ? (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="rounded-full">
                  <UserAvatar avatarUrl={avatarUrl} name={displayName} size={40} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" className="z-50">
                  <UserProfileCard user={author} onMessage={!isOwn ? () => void openAuthorDM() : undefined} />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : (
            <UserAvatar avatarUrl={avatarUrl} name={displayName} size={40} />
          )
        ) : (
          <span className="hidden w-10 select-none text-[10px] text-signal-faint group-hover:inline-block">{formatTime(message.createdAt)}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {showHeader && (
          <div className="flex items-baseline gap-2">
            {author ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="font-semibold text-signal hover:underline">{displayName}</button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="start" className="z-50">
                    <UserProfileCard user={author} onMessage={!isOwn ? () => void openAuthorDM() : undefined} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              <span className="font-semibold text-signal">{displayName}</span>
            )}
            {author?.isOfficial ? <OfficialBadge compact /> : null}
            {author?.isBot ? <BotBadge /> : null}
            {!author && message.webhookId ? <BotBadge label="Webhook" /> : null}
            <span className="text-xs text-signal-faint" title={formatFullDate(message.createdAt)}>
              {formatTime(message.createdAt)}
            </span>
            {message.editedAt ? <span className="text-[10px] text-signal-faint">(edited)</span> : null}
            {message.pinned ? (
              <span className="flex items-center gap-0.5 text-[10px] text-signal-faint">
                <Pin size={10} /> Pinned
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
              className="w-full rounded bg-base-600 px-2 py-1.5 text-sm text-signal outline-none ring-1 ring-accent"
              rows={2}
            />
            <div className="flex gap-2 text-xs text-signal-dim">
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
                className="prose-invert break-words text-sm leading-relaxed text-signal [&_.mention]:rounded [&_.mention]:bg-accent/30 [&_.mention]:px-1 [&_.mention]:text-accent [&_.mention-everyone]:bg-idle/30 [&_.mention-everyone]:text-idle [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-base-900 [&_code]:px-1 [&_code]:py-0.5"
              />
            ) : null}
            {message.attachments.length > 0 && (
              <div className="mt-1 flex flex-col gap-2">
                {message.attachments.map((a) => (
                  <SpoilerAttachment key={a.id} fileName={a.fileName}>
                    {a.mimeType.startsWith("image/") ? (
                      <img
                        src={attachmentUrl(a.url)}
                        alt={stripSpoilerPrefix(a.fileName)}
                        className="max-h-80 max-w-sm rounded-lg border border-base-600"
                      />
                    ) : a.mimeType.startsWith("video/") ? (
                      <video
                        src={attachmentUrl(a.url)}
                        controls
                        preload="metadata"
                        className="max-h-80 max-w-sm rounded-lg border border-base-600"
                      />
                    ) : (
                      <a
                        href={attachmentUrl(a.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-fit items-center gap-2 rounded bg-base-600 px-3 py-2 text-sm text-accent underline"
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
                // it the loudest thing in the channel.
                className="mt-1 h-40 w-40 object-contain"
                draggable={false}
              />
            ) : null}
            {message.poll ? <PollCard poll={message.poll} currentUserId={currentUserId} /> : null}
            <LinkEmbeds embeds={message.embeds} />
            {message.components ? <MessageComponents messageId={message.id} rows={message.components} /> : null}
          </>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => (r.reactedByMe ? onUnreact(message.id, r.emoji) : onReact(message.id, r.emoji))}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs",
                  r.reactedByMe ? "border-accent bg-accent/20 text-accent" : "border-base-500 bg-base-600 text-signal-dim hover:border-signal-dim",
                )}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {message.thread && (
          <button
            onClick={() => onOpenThread?.(message.thread!.id)}
            className="mt-1.5 flex items-center gap-2 rounded-md border border-base-500 bg-base-800/60 px-2.5 py-1.5 text-left text-xs hover:border-accent"
          >
            <MessagesSquare size={13} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate font-medium text-signal">{message.thread.name}</span>
            <span className="shrink-0 text-signal-faint">
              {message.thread.messageCount === 1 ? "1 reply" : `${message.thread.messageCount} replies`}
              {message.thread.archived ? " · archived" : ""}
            </span>
          </button>
        )}
      </div>

      {!editing && (
        <div className="absolute right-4 top-0 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-base-500 bg-base-700 shadow group-hover:flex">
          <ReactionPicker onPick={(emoji) => onReact(message.id, emoji)} />
          <button onClick={() => onReply(message)} className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal" title="Reply">
            <Reply size={16} />
          </button>
          {onStartThread && message.channelId && (
            <button
              onClick={() => (message.thread ? onOpenThread?.(message.thread.id) : onStartThread(message))}
              className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal"
              title={message.thread ? "Open thread" : "Start a thread"}
            >
              <MessagesSquare size={16} />
            </button>
          )}
          {onTogglePin && canManage && message.channelId && (
            <button
              onClick={() => onTogglePin(message.id, !message.pinned)}
              className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal"
              title={message.pinned ? "Unpin" : "Pin"}
            >
              {message.pinned ? <PinOff size={16} /> : <Pin size={16} />}
            </button>
          )}
          {canEdit && (
            <button onClick={() => setEditing(true)} className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-signal" title="Edit">
              <Pencil size={16} />
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => void onDelete(message.id)}
              className="rounded p-1 text-signal-dim hover:bg-base-500 hover:text-dnd"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
