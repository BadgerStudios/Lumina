import { useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { DMConversationDTO, MessageDTO } from "@lumina/shared";
import { MessageList } from "../chat/MessageList";
import { Composer } from "../chat/Composer";
import { TypingIndicator } from "../chat/TypingIndicator";
import { SearchResultsPanel } from "../chat/SearchResultsPanel";
import { RoomHeader } from "./RoomHeader";
import { useAuthStore } from "../../store/authStore";
import { useUIStore, selectAsideOpen } from "../../store/uiStore";
import {
  useEditMessage,
  useDeleteMessage,
  useAddReaction,
  useRemoveReaction,
  useTogglePinMessage,
  usePinnedMessages,
  type RichSendPayload,
} from "../../queries/messages";

/**
 * A conversation, framed as a floating pane on the shell's canvas.
 *
 * Structurally this is where the app stopped looking like a chat client with a header bar bolted
 * on: the room's context is a translucent capsule inset from the pane's own edges, and the things
 * that used to hover over the messages (pins) moved out to the contextual aside instead, so the
 * conversation itself is never covered by its own chrome.
 */
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
  onSendRich,
  typingChannelId,
  serverId,
  target,
  canManageMessages,
  onSearch,
  dmReadStates,
  dmParticipants,
  onOpenThread,
  onStartThread,
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
  onSendRich?: (payload: RichSendPayload) => Promise<void>;
  typingChannelId?: string;
  serverId?: string;
  target: { channelId?: string; dmConversationId?: string };
  canManageMessages: boolean;
  onSearch?: (q: string) => void;
  dmReadStates?: DMConversationDTO["readStates"];
  dmParticipants?: DMConversationDTO["participants"];
  /** Both absent in DMs — threads exist only inside server channels. */
  onOpenThread?: (threadId: string) => void;
  onStartThread?: (message: MessageDTO) => void;
}) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage(target);
  const addReaction = useAddReaction();
  const removeReaction = useRemoveReaction();
  const togglePin = useTogglePinMessage();
  const openAsideTab = useUIStore((s) => s.openAsideTab);
  const asideTab = useUIStore((s) => s.asideTab);
  const asideOpen = useUIStore(selectAsideOpen);
  const [replyTo, setReplyTo] = useState<{ id: string; authorLabel: string } | null>(null);
  // Owned here rather than threaded down from each route: ChatPane already renders the header that
  // holds the input, and requiring every caller to pass an `onSearch` is precisely why the search
  // box never rendered anywhere — one route forgetting to wire it made the feature invisible.
  const [searchQuery, setSearchQuery] = useState("");
  // Fetched regardless of panel visibility so the header's badge count is accurate even before the
  // aside has ever been opened; PinnedList shares this exact cache entry (identical query key), so
  // opening the tab doesn't double-fetch.
  const { data: pins } = usePinnedMessages(target.channelId, !!target.channelId);
  // Pins live in the aside, and the aside only exists inside a space — a DM has no third column to
  // put them in, and no pins either.
  const canShowPins = Boolean(serverId && target.channelId);

  return (
    <div className="lx-pane relative flex h-full min-w-0 flex-1 flex-col max-md:rounded-none max-md:border-x-0 max-md:border-b-0">
      <RoomHeader
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
        pinnedCount={canShowPins ? pins?.length : undefined}
        onTogglePins={canShowPins ? () => openAsideTab("pins") : undefined}
        pinsOpen={canShowPins && asideTab === "pins" && asideOpen}
      />
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
        onOpenThread={onOpenThread}
        onStartThread={onStartThread}
        dmReadStates={dmReadStates}
        dmParticipants={dmParticipants}
      />
      {typingChannelId ? <TypingIndicator channelId={typingChannelId} serverId={serverId} /> : <div className="h-5" />}
      <Composer
        placeholder={`Message ${title}`}
        onSend={onSend}
        onSendWithAttachments={onSendWithAttachments}
        onSendRich={onSendRich}
        typingChannelId={typingChannelId}
        serverId={serverId}
        dmConversationId={target.dmConversationId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  );
}
