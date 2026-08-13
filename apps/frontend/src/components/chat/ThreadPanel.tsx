import { useState } from "react";
import { X, Archive, ArchiveRestore, Bell, BellOff, MessagesSquare } from "lucide-react";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { useThread, useSetThreadJoined, useSetThreadArchived } from "../../queries/threads";
import {
  useMessages,
  useSendChannelMessage,
  useSendChannelMessageWithAttachments,
  useEditMessage,
  useDeleteMessage,
  useAddReaction,
  useRemoveReaction,
} from "../../queries/messages";
import { useChannelRoom } from "../../socket/useChannelRoom";
import { useAuthStore } from "../../store/authStore";

/**
 * The thread reading/posting surface, docked beside the channel.
 *
 * Everything in here is the ORDINARY channel machinery pointed at the thread's id — `useMessages`,
 * `useSendChannelMessage`, `useChannelRoom`, the same MessageList and Composer. That is the entire
 * payoff of modelling a thread as a Channel row: no parallel query layer, no second socket room
 * concept, no thread-specific message cache. If this file had needed its own versions of those,
 * the schema decision would have been the wrong one.
 */
export function ThreadPanel({
  threadId,
  canManageMessages,
  onClose,
}: {
  threadId: string;
  canManageMessages: boolean;
  onClose: () => void;
}) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data: thread } = useThread(threadId);
  const setJoined = useSetThreadJoined(threadId);
  const setArchived = useSetThreadArchived(threadId);

  // Same room join a channel does — this is what makes replies arrive live.
  useChannelRoom(threadId);

  const messagesQuery = useMessages(threadId);
  const sendMessage = useSendChannelMessage(threadId);
  const sendWithAttachments = useSendChannelMessageWithAttachments(threadId);
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage({ channelId: threadId });
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();

  const [replyTo, setReplyTo] = useState<{ id: string; authorLabel: string } | null>(null);

  return (
    <aside className="flex w-full shrink-0 flex-col border-l border-base-700 bg-base-800 md:w-96">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-base-700 px-3">
        <MessagesSquare size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-signal">{thread?.name ?? "Thread"}</span>

        {thread && (
          <button
            onClick={() => setJoined.mutate(!thread.joined)}
            disabled={setJoined.isPending}
            className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal"
            title={thread.joined ? "Stop following this thread" : "Follow this thread"}
          >
            {thread.joined ? <Bell size={15} /> : <BellOff size={15} />}
          </button>
        )}
        {thread && (
          <button
            onClick={() => setArchived.mutate(!thread.archived)}
            disabled={setArchived.isPending}
            className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal"
            title={thread.archived ? "Reopen thread" : "Archive thread"}
          >
            {thread.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </button>
        )}
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1.5 text-signal-dim hover:bg-base-700 hover:text-signal"
          title="Close thread"
        >
          <X size={16} />
        </button>
      </header>

      {thread?.archived && (
        <p className="shrink-0 border-b border-base-700 bg-base-900 px-3 py-2 text-xs text-signal-faint">
          This thread is archived. Posting will reopen it.
        </p>
      )}

      <MessageList
        data={messagesQuery.data}
        isLoading={messagesQuery.isLoading}
        hasNextPage={messagesQuery.hasNextPage}
        isFetchingNextPage={messagesQuery.isFetchingNextPage}
        fetchNextPage={() => void messagesQuery.fetchNextPage()}
        currentUserId={currentUserId}
        canManage={canManageMessages}
        onEdit={async (messageId, content) => {
          await editMessage.mutateAsync({ messageId, content });
        }}
        onDelete={async (messageId) => {
          await deleteMessage.mutateAsync(messageId);
        }}
        onReply={(m) => setReplyTo({ id: m.id, authorLabel: m.author?.displayName ?? m.author?.username ?? "someone" })}
        onReact={(messageId, emoji) => addReaction.mutate({ messageId, emoji })}
        onUnreact={(messageId, emoji) => removeReaction.mutate({ messageId, emoji })}
      />

      <div className="shrink-0 px-3 pb-3">
        <Composer
          placeholder={`Reply to ${thread?.name ?? "thread"}`}
          typingChannelId={threadId}
          serverId={thread?.serverId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={async (content, replyToId) => {
            await sendMessage.mutateAsync({ content, replyToId });
            setReplyTo(null);
          }}
          onSendWithAttachments={async (content, files, replyToId) => {
            await sendWithAttachments.mutateAsync({ content, files, replyToId });
            setReplyTo(null);
          }}
        />
      </div>
    </aside>
  );
}
