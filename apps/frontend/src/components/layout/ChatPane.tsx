import { useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { DMConversationDTO, MessageDTO } from "@lumina/shared";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { TypingIndicator } from "../chat/TypingIndicator";
import { PinnedMessagesPanel } from "../chat/PinnedMessagesPanel";
import { SearchResultsPanel } from "../chat/SearchResultsPanel";
import { TopBar } from "./TopBar";
import { useAuthStore } from "../../store/authStore";
import {
  useEditMessage,
  useDeleteMessage,
  useAddReaction,
  useRemoveReaction,
  useTogglePinMessage,
  usePinnedMessages,
} from "../../queries/messages";

export function ChatPane({
  title,
  topic,
  messages,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onSend,
  onSendWithAttachments,
  typingChannelId,
  serverId,
  target,
  canManageMessages,
  onSearch,
  dmReadStates,
  dmParticipants,
}: {
  title: string;
  topic?: string | null;
  messages: InfiniteData<MessageDTO[]> | undefined;
  isLoading: boolean;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  onSend: (content: string, replyToId: string | null) => Promise<void>;
  onSendWithAttachments?: (content: string, files: File[], replyToId: string | null) => Promise<void>;
  typingChannelId?: string;
  serverId?: string;
  target: { channelId?: string; dmConversationId?: string };
  canManageMessages: boolean;
  onSearch?: (q: string) => void;
  dmReadStates?: DMConversationDTO["readStates"];
  dmParticipants?: DMConversationDTO["participants"];
}) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage(target);
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();
  const togglePin = useTogglePinMessage();
  const [replyTo, setReplyTo] = useState<{ id: string; authorLabel: string } | null>(null);
  const [showPins, setShowPins] = useState(false);
  // Owned here rather than threaded down from each route: ChatPane already renders the TopBar that
  // holds the input, and requiring every caller to pass an `onSearch` is precisely why the search
  // box never rendered anywhere — one route forgetting to wire it made the feature invisible.
  const [searchQuery, setSearchQuery] = useState("");
  // Fetched regardless of panel visibility so the TopBar badge count is accurate even before
  // the user has ever opened the panel; usePinnedMessages inside PinnedMessagesPanel shares
  // this same cache entry (identical query key), so opening the panel doesn't double-fetch.
  const { data: pins } = usePinnedMessages(target.channelId, !!target.channelId);

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-base-700">
      <TopBar
        title={title}
        topic={topic}
        onSearch={
          serverId
            ? (q) => {
                setSearchQuery(q);
                onSearch?.(q);
              }
            : onSearch
        }
        serverId={serverId}
        pinnedCount={pins?.length}
        onTogglePins={target.channelId ? () => setShowPins((s) => !s) : undefined}
      />
      {showPins && target.channelId ? (
        <PinnedMessagesPanel channelId={target.channelId} canManage={canManageMessages} onClose={() => setShowPins(false)} />
      ) : null}
      {serverId && searchQuery.trim().length > 1 ? (
        <SearchResultsPanel serverId={serverId} query={searchQuery.trim()} onClose={() => setSearchQuery("")} />
      ) : null}
      <MessageList
        data={messages}
        isLoading={isLoading}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
        canManage={canManageMessages}
        currentUserId={currentUserId}
        onEdit={(messageId, content) => editMessage.mutateAsync({ messageId, content }).then(() => undefined)}
        onDelete={(messageId) => deleteMessage.mutateAsync(messageId).then(() => undefined)}
        onReply={(message) =>
          setReplyTo({ id: message.id, authorLabel: message.author?.displayName ?? message.author?.username ?? "message" })
        }
        onReact={(messageId, emoji) => addReaction.mutate({ messageId, emoji })}
        onUnreact={(messageId, emoji) => removeReaction.mutate({ messageId, emoji })}
        onTogglePin={(messageId, pinned) => togglePin.mutate({ messageId, pinned })}
        dmReadStates={dmReadStates}
        dmParticipants={dmParticipants}
      />
      {typingChannelId ? <TypingIndicator channelId={typingChannelId} serverId={serverId} /> : <div className="h-5" />}
      <Composer
        placeholder={`Message ${title}`}
        onSend={onSend}
        onSendWithAttachments={onSendWithAttachments}
        typingChannelId={typingChannelId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  );
}
