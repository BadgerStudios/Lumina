import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { DMSidebar } from "../components/layout/DMSidebar";
import { ChatPane } from "../components/layout/ChatPane";
import { useDMs, useMarkDMRead } from "../queries/dms";
import { useDMMessages, useSendDMMessage, useSendDMMessageWithAttachments } from "../queries/messages";
import { useAuthStore } from "../store/authStore";

export function DMRoute() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const user = useAuthStore((s) => s.user);
  const { data: conversations } = useDMs();
  const conversation = conversations?.find((c) => c.id === conversationId);

  const messagesQuery = useDMMessages(conversationId);
  const sendMessage = useSendDMMessage(conversationId ?? "");
  const sendWithAttachments = useSendDMMessageWithAttachments(conversationId ?? "");
  const markRead = useMarkDMRead(conversationId ?? "");

  // Marks read whenever the conversation is open and its last message changes (a new message
  // arriving while you're already viewing the DM should still advance your read position, not
  // just the initial open).
  useEffect(() => {
    if (conversationId) markRead.mutate();
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
    <>
      <DMSidebar />
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
        target={{ dmConversationId: conversationId }}
        canManageMessages={false}
        dmReadStates={conversation?.readStates}
        dmParticipants={conversation?.participants}
      />
    </>
  );
}
