import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ChatPane } from "../components/layout/ChatPane";
import { useDMs, useMarkDMRead } from "../queries/dms";
import {
  useDMMessages,
  useMessageFocus,
  useSendDMMessage,
  useSendDMMessageWithAttachments,
  useSendDMMessageRich,
} from "../queries/messages";
import { useAuthStore } from "../store/authStore";

export function DMRoute() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const user = useAuthStore((s) => s.user);
  const { data: conversations } = useDMs();
  const conversation = conversations?.find((c) => c.id === conversationId);

  const messagesQuery = useDMMessages(conversationId);
  const { focusMessageId, focusNonce } = useMessageFocus({ dmConversationId: conversationId }, !messagesQuery.isLoading);
  const sendMessage = useSendDMMessage(conversationId ?? "");
  const sendWithAttachments = useSendDMMessageWithAttachments(conversationId ?? "");
  const sendRich = useSendDMMessageRich(conversationId ?? "");
  const markRead = useMarkDMRead(conversationId ?? "");

  // The read position captured when this DM was opened — where the "new messages" divider sits.
  // Frozen for the visit, reset when the conversation changes.
  const [unreadBoundaryId, setUnreadBoundaryId] = useState<string | null>(null);
  const boundaryConvRef = useRef<string | undefined>(undefined);

  // Marks read whenever the conversation is open and its last message changes (a new message
  // arriving while you're already viewing the DM should still advance your read position, not
  // just the initial open).
  // Only the FIRST mark of a conversation seeds the divider boundary; the later marks that new
  // messages trigger advance the cursor without moving the divider out from under you.
  useEffect(() => {
    if (!conversationId) return;
    if (boundaryConvRef.current !== conversationId) {
      boundaryConvRef.current = conversationId;
      setUnreadBoundaryId(null);
      void markRead
        .mutateAsync()
        .then((res) => setUnreadBoundaryId(res?.previousLastReadMessageId ?? null))
        .catch(() => undefined);
    } else {
      markRead.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conversation?.lastMessage?.id]);

  const other = conversation?.participants.find((p) => p.id !== user?.id) ?? conversation?.participants[0];
  const title = conversation
    ? conversation.isGroup
      ? (conversation.name ?? conversation.participants.map((p) => p.displayName ?? p.username).join(", "))
      : (other?.displayName ?? other?.username ?? "Direct Message")
    : "";

  if (!conversationId) {
    return <div className="flex flex-1 items-center justify-center text-signal-faint">Loading…</div>;
  }

  return (
    <ChatPane
      title={title}
      messages={messagesQuery.data}
      isLoading={messagesQuery.isLoading}
      hasNextPage={messagesQuery.hasNextPage}
      isFetchingNextPage={messagesQuery.isFetchingNextPage}
      fetchNextPage={() => void messagesQuery.fetchNextPage()}
      onSend={async (content, replyToId) => {
        await sendMessage.mutateAsync({ content, replyToId });
      }}
      onSendWithAttachments={async (content, files, replyToId) => {
        await sendWithAttachments.mutateAsync({ content, files, replyToId });
      }}
      onSendRich={async (payload) => {
        await sendRich.mutateAsync(payload);
      }}
      target={{ dmConversationId: conversationId }}
      canManageMessages={false}
      dmReadStates={conversation?.readStates}
      dmParticipants={conversation?.participants}
      lastReadMessageId={unreadBoundaryId ?? undefined}
      focusMessageId={focusMessageId}
      focusNonce={focusNonce}
    />
  );
}
