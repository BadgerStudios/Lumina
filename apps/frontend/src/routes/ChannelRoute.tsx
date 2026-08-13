import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChannelSidebar } from "../components/layout/ChannelSidebar";
import { ChatPane } from "../components/layout/ChatPane";
import { MemberList } from "../components/layout/MemberList";
import { useChannels } from "../queries/channels";
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
import { useUIStore } from "../store/uiStore";
import { useActiveSelectionStore } from "../store/activeSelectionStore";
import { can } from "../lib/permissions";

export function ChannelRoute() {
  const { serverId, channelId } = useParams<{ serverId: string; channelId: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const memberListCollapsed = useUIStore((s) => s.memberListCollapsed);
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

  const messagesQuery = useMessages(validChannelId);
  const sendMessage = useSendChannelMessage(validChannelId ?? "");
  const sendWithAttachments = useSendChannelMessageWithAttachments(validChannelId ?? "");
  const sendRich = useSendChannelMessageRich(validChannelId ?? "");

  const me = members?.find((m) => m.userId === user?.id);
  const canManageMessages = can("MANAGE_MESSAGES", { userId: user?.id, server, member: me, roles });

  // The ServerRail links to `_` as a placeholder before its own channel list has loaded, and a
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
      <ChannelSidebar serverId={serverId} activeChannelId={validChannelId} />
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
      />
      {!memberListCollapsed && <MemberList serverId={serverId} />}
    </>
  );
}
