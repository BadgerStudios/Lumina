import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChatPane } from "../components/layout/ChatPane";
import { ThreadPanel } from "../components/chat/ThreadPanel";
import { ActivityFrame } from "../components/game/ActivityFrame";
import { AsidePanel } from "../components/layout/AsidePanel";
import { useChannels } from "../queries/channels";
import { useCreateThread } from "../queries/threads";
import { useServer } from "../queries/servers";
import { useMembers } from "../queries/members";
import { useRoles } from "../queries/roles";
import {
  useMessages,
  useSendChannelMessage,
  useSendChannelMessageWithAttachments,
  useSendChannelMessageRich,
} from "../queries/messages";
import { useMarkChannelRead } from "../queries/readState";
import { useChannelRoom } from "../socket/useChannelRoom";
import { useAuthStore } from "../store/authStore";
import { useActiveSelectionStore } from "../store/activeSelectionStore";
import { can } from "../lib/permissions";

export function ChannelRoute() {
  const { serverId, channelId } = useParams<{ serverId: string; channelId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setActiveChannel = useActiveSelectionStore((s) => s.setActiveChannel);

  const { data: server } = useServer(serverId);
  const { data: channels } = useChannels(serverId);
  const { data: members } = useMembers(serverId);
  const { data: roles } = useRoles(serverId);

  const channel = channels?.find((c) => c.id === channelId);
  const validChannelId = channel ? channelId : undefined;

  useChannelRoom(validChannelId);

  const markRead = useMarkChannelRead(serverId);

  // Tracks which channel is currently open (read by socket/useSocketEvents.ts's
  // message:create handler for mark-as-read-as-you-go) and marks it read the moment it
  // becomes active, so the Signal panel's badge clears without requiring a manual action.
  useEffect(() => {
    setActiveChannel(validChannelId ?? null);
    if (validChannelId) markRead.mutate(validChannelId);
    return () => setActiveChannel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validChannelId]);

  // Panel state, not URL state: a thread is docked beside the channel rather than somewhere you
  // navigate to, so putting it in the URL would make the back button close a side panel instead of
  // leaving the channel. In the store rather than local state because the sidebar's thread list
  // opens the same panel — see activeSelectionStore.
  const openThreadId = useActiveSelectionStore((s) => s.openThreadId);
  const setOpenThreadId = useActiveSelectionStore((s) => s.setOpenThread);
  const openActivity = useActiveSelectionStore((s) => s.openActivity);
  const setOpenActivity = useActiveSelectionStore((s) => s.setOpenActivity);
  const createThread = useCreateThread(validChannelId ?? "");

  const messagesQuery = useMessages(validChannelId);
  const sendMessage = useSendChannelMessage(validChannelId ?? "");
  const sendWithAttachments = useSendChannelMessageWithAttachments(validChannelId ?? "");
  const sendRich = useSendChannelMessageRich(validChannelId ?? "");

  const me = members?.find((m) => m.userId === user?.id);
  const canManageMessages = can("MANAGE_MESSAGES", { userId: user?.id, server, member: me, roles });

  // The nav deck links to `_` as a placeholder before a space's room list has loaded, and a
  // channel can also be deleted out from under a currently-viewing user — both cases redirect
  // to the server's first available text channel once we know what that is.
  useEffect(() => {
    if (!serverId || !channels || channels.length === 0) return;
    if (channel) return;
    const firstText = [...channels].filter((c) => c.type === "TEXT").sort((a, b) => a.position - b.position)[0];
    if (firstText) navigate(`/channels/${serverId}/${firstText.id}`, { replace: true });
  }, [serverId, channels, channel, navigate]);

  if (!serverId || !validChannelId) {
    return <div className="flex flex-1 items-center justify-center text-signal-faint">Loading channel…</div>;
  }

  return (
    <>
      <ChatPane
        title={channel?.name ?? ""}
        topic={channel?.topic}
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
        typingChannelId={validChannelId}
        serverId={serverId}
        target={{ channelId: validChannelId }}
        canManageMessages={canManageMessages}
        onOpenThread={(threadId) => setOpenThreadId(threadId)}
        onStartThread={async (message) => {
          // Seeded from the message being threaded so the prompt is answerable without retyping —
          // and trimmed to the same 100 characters the API accepts, so a long message cannot
          // produce a name the server will reject.
          const suggested = message.content.trim().slice(0, 100) || "New thread";
          const name = window.prompt("Thread name", suggested);
          if (!name?.trim()) return;
          const thread = await createThread.mutateAsync({ name: name.trim(), originMessageId: message.id });
          setOpenThreadId(thread.id);
        }}
      />
      {openThreadId && (
        <ThreadPanel
          threadId={openThreadId}
          canManageMessages={canManageMessages}
          onClose={() => setOpenThreadId(null)}
        />
      )}
      {openActivity && !openThreadId && (
        <ActivityFrame
          activity={openActivity}
          channelId={validChannelId}
          serverId={serverId}
          onClose={() => setOpenActivity(null)}
        />
      )}
      {/* Three panes is the most the content row can carry; a docked thread or an embedded
          activity is itself the contextual panel for as long as it is open. */}
      {!openThreadId && !openActivity && (
        <AsidePanel serverId={serverId} channelId={validChannelId} canManageMessages={canManageMessages} />
      )}
    </>
  );
}
