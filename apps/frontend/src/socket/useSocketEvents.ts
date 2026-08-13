import { useEffect } from "react";
import { forceUpdateCheck } from "../queries/meta";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ServerEvents } from "@lumina/shared";
import type {
  ChannelDTO,
  DMConversationDTO,
  FriendRequestDTO,
  MemberDTO,
  MessageDTO,
  RoleDTO,
  ServerDTO,
  UserDTO,
  VoiceParticipantDTO,
} from "@lumina/shared";
import { getSocket } from "./socketClient";
import { queryKeys } from "../lib/queryKeys";
import { api } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import { useUIStore } from "../store/uiStore";
import { playNotificationSound } from "../lib/notificationSound";
import { usePresenceStore } from "../store/presenceStore";
import { useTypingStore } from "../store/typingStore";
import { useActiveSelectionStore } from "../store/activeSelectionStore";
import { useVoiceStore } from "../store/voiceStore";
import {
  patchMessageDelete,
  patchMessageUpdate,
  patchPollVote,
  patchMessageEmbeds,
  type PollVotePayload,
  type EmbedsPayload,
  patchReaction,
  removeById,
  upsertById,
  upsertChannel,
  upsertMember,
  upsertMessageCreate,
  upsertRole,
  removeMember,
  type MessagePages,
  type ReactionEventPayload,
} from "./cachePatches";

/** Finds which cached ["messages", ...] query (channel or DM) currently holds a message with
 * this id. Needed because message:delete / reaction:add / reaction:remove payloads don't carry
 * channelId/conversationId (server just broadcasts to the room; the payload itself is bare) —
 * so we have to search the caches we already have rather than guess which one to patch. */
function findMessageQueryKey(queryClient: QueryClient, messageId: string): readonly unknown[] | undefined {
  const queries = queryClient.getQueryCache().findAll({ predicate: (q) => q.queryKey[0] === "messages" });
  for (const q of queries) {
    const data = q.state.data as MessagePages;
    if (data?.pages.some((page) => page.some((m) => m.id === messageId))) {
      return q.queryKey;
    }
  }
  return undefined;
}

function messageTargetKey(message: MessageDTO): readonly unknown[] {
  return message.channelId ? queryKeys.messages(message.channelId) : queryKeys.dmMessages(message.dmConversationId!);
}

/**
 * Mounted once near the app root once a session exists. Subscribes to every ServerEvents.*
 * name and patches TanStack Query cache / zustand stores directly — no invalidate-and-refetch,
 * per the realtime requirement: a refetch storm on every keystroke-adjacent event would not
 * feel realtime. The actual patch logic is factored into cachePatches.ts as pure functions so
 * it's unit-testable without mounting this hook (see scripts/verify-realtime.mjs).
 */
export function useSocketEvents(): void {
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const setPresence = usePresenceStore((s) => s.setPresence);
  const setTyping = useTypingStore((s) => s.setTyping);

  useEffect(() => {
    const socket = getSocket();

    const onMessageCreate = (message: MessageDTO) => {
      queryClient.setQueryData<MessagePages>(messageTargetKey(message), (old) => upsertMessageCreate(old, message));
      if (message.dmConversationId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.dms(), refetchType: "inactive" });
        if (message.authorId !== useAuthStore.getState().user?.id && useUIStore.getState().notificationSoundEnabled) {
          playNotificationSound();
        }
      }
      if (message.channelId) {
        // Mark-as-read-as-you-go: if the user has this exact channel open right now, a newly
        // arriving message shouldn't leave a stale Signal badge behind waiting for them to
        // navigate away and back (see routes/ChannelRoute.tsx, which sets activeChannelId).
        if (message.channelId === useActiveSelectionStore.getState().activeChannelId) {
          void api.patch(`/channels/${message.channelId}/read`).catch(() => undefined);
        }
        // No dedicated unread-delta socket event exists (see queries/readState.ts) — refetching
        // just the mounted/active ["unread", serverId] queries on every channel message is cheap
        // and keeps the Signal panel live instead of waiting out its poll interval.
        queryClient.invalidateQueries({ queryKey: ["unread"], refetchType: "active" });
      }
    };

    const onMessageUpdate = (message: MessageDTO) => {
      queryClient.setQueryData<MessagePages>(messageTargetKey(message), (old) => patchMessageUpdate(old, message));
      if (message.channelId) {
        // Covers pin/unpin (see queries/messages.ts useTogglePinMessage): message:update is the
        // same broadcast a content edit uses, so any viewer's open pinned-messages panel needs
        // to catch it too, not just the actor's own optimistic update.
        queryClient.invalidateQueries({ queryKey: [...queryKeys.messages(message.channelId), "pins"] });
      }
    };

    // Live poll tallies. Uses the same findMessageQueryKey walk as reactions: the payload names a
    // message, not a channel, and the message may be in either a channel or a DM cache.
    const onPollVote = (payload: PollVotePayload) => {
      const key = findMessageQueryKey(queryClient, payload.messageId);
      if (key) queryClient.setQueryData<MessagePages>(key, (old) => patchPollVote(old, payload, currentUserId));
    };

    // Link unfurls, which arrive after the message did — the fetch happens out-of-band on the
    // worker. Without this the card only appears on a reload, which reads as "previews don't work".
    const onMessageEmbeds = (payload: EmbedsPayload) => {
      const key = findMessageQueryKey(queryClient, payload.messageId);
      if (key) queryClient.setQueryData<MessagePages>(key, (old) => patchMessageEmbeds(old, payload));
    };

    const onMessageDelete = (payload: { id: string }) => {
      const key = findMessageQueryKey(queryClient, payload.id);
      if (key) queryClient.setQueryData<MessagePages>(key, (old) => patchMessageDelete(old, payload.id));
    };

    const onReaction = (isAdd: boolean) => (payload: ReactionEventPayload) => {
      const key = findMessageQueryKey(queryClient, payload.messageId);
      if (key) queryClient.setQueryData<MessagePages>(key, (old) => patchReaction(old, payload, isAdd, currentUserId));
    };

    const onTypingUpdate = (payload: { channelId: string; userId: string; isTyping: boolean }) => {
      if (payload.userId === currentUserId) return; // don't show "typing" for yourself
      setTyping(payload.channelId, payload.userId, payload.isTyping);
    };

    const onPresenceUpdate = (payload: { userId: string; presence: UserDTO["presence"] }) => {
      setPresence(payload.userId, payload.presence);
    };

    const onMemberJoin = (member: MemberDTO) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(member.serverId), (old) => upsertMember(old, member));
    };
    const onMemberUpdate = (member: MemberDTO) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(member.serverId), (old) => upsertMember(old, member));
    };
    const onMemberLeave = (payload: { userId: string; serverId: string }) => {
      queryClient.setQueryData<MemberDTO[]>(queryKeys.members(payload.serverId), (old) => removeMember(old, payload.userId));
    };

    const onChannelCreate = (channel: ChannelDTO) => {
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(channel.serverId), (old) => upsertChannel(old, channel));
    };
    const onChannelUpdate = (channel: ChannelDTO) => {
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(channel.serverId), (old) => upsertChannel(old, channel));
    };
    const onChannelDelete = (payload: { id: string; serverId: string }) => {
      queryClient.setQueryData<ChannelDTO[]>(queryKeys.channels(payload.serverId), (old) => removeById(old, payload.id));
    };

    const onChannelOverwritesUpdate = (payload: { channelId: string }) => {
      // Refetch rather than patch: the effective permissions differ per recipient, so the server
      // cannot broadcast one correct answer. Invalidating the channel list is the important half
      // — this event is what makes a channel appear in, or vanish from, this member's sidebar.
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelOverwrites(payload.channelId) });
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
    };

    const onThreadChange = (thread: { id: string; parentId: string | null }) => {
      // Refetch rather than patch: thread lists are split by archived state and ordered by
      // activity, so an insert has no single correct position to patch into.
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(thread.id) });
      // The origin message renders the "N replies" affordance from its own cache entry.
      if (thread.parentId) void queryClient.invalidateQueries({ queryKey: queryKeys.messages(thread.parentId) });
    };

    const onRoleCreate = (role: RoleDTO) => {
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(role.serverId), (old) => upsertRole(old, role));
    };
    const onRoleUpdate = (role: RoleDTO) => {
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(role.serverId), (old) => upsertRole(old, role));
    };
    const onRoleDelete = (payload: { id: string; serverId: string }) => {
      queryClient.setQueryData<RoleDTO[]>(queryKeys.roles(payload.serverId), (old) => removeById(old, payload.id));
    };

    const onServerUpdate = (server: ServerDTO) => {
      queryClient.setQueryData(queryKeys.server(server.id), server);
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) => (old ? upsertById(old, server) : old));
    };
    const onServerDelete = (payload: { id: string }) => {
      queryClient.setQueryData<ServerDTO[]>(queryKeys.servers(), (old) => removeById(old, payload.id));
    };

    const onDMCreate = (conversation: DMConversationDTO) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) => {
        if (!old) return [conversation];
        if (old.some((c) => c.id === conversation.id)) return old;
        return [conversation, ...old];
      });
    };

    // Group DM rename / participant add — always a full re-serialized DTO (see
    // modules/dm/routes.ts), so this is a plain replace-by-id, not a field-level patch.
    // A staff decision (or a transcode finishing) on one of this user's own uploads. Invalidating
    // rather than hand-patching: "My videos" is a plain list query, and an approval also changes
    // what the public feed should contain, so a refetch is both simpler and more correct here.
    const onVideoStatusUpdate = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myVideos() });
      queryClient.invalidateQueries({ queryKey: queryKeys.feed() });
    };

    // A moderator closed a report this user filed (modules/staff/reports.ts). The outcome is
    // delivered by refetching rather than patching the payload in — "My reports" is a plain list
    // and the rating control only appears once the server says the ticket is closed.
    const onReportResolved = () => {
      queryClient.invalidateQueries({ queryKey: ["myReports"] });
    };

    // Your own platform role changed. Re-fetch the whole /auth/me record rather than patching the
    // role in from the payload: a promotion can carry other server-side consequences, and the
    // authoritative answer to "who am I" is the one endpoint that returns it. The rail entry, the
    // mobile tab and the staff suite all key off this, so they appear the moment it lands rather
    // than at the next window focus.
    const onPlatformRoleUpdate = () => {
      void api
        .get<UserDTO>("/auth/me")
        .then((me) => useAuthStore.getState().setUser(me))
        .catch(() => undefined);
    };

    const onDMUpdate = (conversation: DMConversationDTO) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) =>
        old ? old.map((c) => (c.id === conversation.id ? conversation : c)) : old,
      );
    };

    const onDMParticipantRemoved = (payload: { conversationId: string }) => {
      queryClient.setQueryData<DMConversationDTO[]>(queryKeys.dms(), (old) => removeById(old, payload.conversationId));
    };

    // Payload is { message, serverId, channelId } (see modules/messages/mentions.ts) but the
    // Activity feed just needs to know "go refetch" — it's a low-frequency event, no need for
    // a hand-patched insert like the higher-traffic handlers above.
    const onMentionNotification = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.myMentions() });
      if (useUIStore.getState().notificationSoundEnabled) playNotificationSound();
    };

    // Friend request lifecycle push (modules/friends/service.ts) — invalidate rather than
    // hand-patch, same low-frequency-event treatment as mentions above; the existing 20s poll
    // in queries/friends.ts stays as a fallback for anything this misses.
    const onFriendRequestChange = (_payload: FriendRequestDTO) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests() });
      queryClient.invalidateQueries({ queryKey: queryKeys.friends() });
    };

    // Server-wide voice roster (realtime/handlers/voice.ts) — lets ChannelSidebar show who's in
    // a voice channel without the viewer having joined it themselves.
    const onVoiceRosterUpdate = (payload: { channelId: string; participants: VoiceParticipantDTO[] }) => {
      useVoiceStore.getState().setChannelRoster(payload.channelId, payload.participants);
    };

    // A deploy just published. Every platform re-runs the check it already owns: Android refetches
    // the version manifest, the web build re-compares its entry-script hash, and desktop is handled
    // in the Electron main process. Nothing here decides whether an update exists — it only decides
    // when to look.
    const onAppUpdate = () => {
      forceUpdateCheck();
      void queryClient.invalidateQueries({ queryKey: ["meta", "version"] });
    };
    socket.on(ServerEvents.APP_UPDATE_AVAILABLE, onAppUpdate);

    socket.on(ServerEvents.MESSAGE_CREATE, onMessageCreate);
    socket.on(ServerEvents.MESSAGE_UPDATE, onMessageUpdate);
    socket.on(ServerEvents.MESSAGE_DELETE, onMessageDelete);
    socket.on(ServerEvents.POLL_VOTE_UPDATE, onPollVote);
    socket.on(ServerEvents.MESSAGE_EMBEDS_UPDATE, onMessageEmbeds);
    socket.on(ServerEvents.REACTION_ADD, onReaction(true));
    socket.on(ServerEvents.REACTION_REMOVE, onReaction(false));
    socket.on(ServerEvents.TYPING_UPDATE, onTypingUpdate);
    socket.on(ServerEvents.PRESENCE_UPDATE, onPresenceUpdate);
    socket.on(ServerEvents.MEMBER_JOIN, onMemberJoin);
    socket.on(ServerEvents.MEMBER_UPDATE, onMemberUpdate);
    socket.on(ServerEvents.MEMBER_LEAVE, onMemberLeave);
    socket.on(ServerEvents.CHANNEL_CREATE, onChannelCreate);
    socket.on(ServerEvents.CHANNEL_UPDATE, onChannelUpdate);
    socket.on(ServerEvents.CHANNEL_DELETE, onChannelDelete);
    socket.on(ServerEvents.CHANNEL_OVERWRITES_UPDATE, onChannelOverwritesUpdate);
    socket.on(ServerEvents.THREAD_CREATE, onThreadChange);
    socket.on(ServerEvents.THREAD_UPDATE, onThreadChange);
    socket.on(ServerEvents.ROLE_CREATE, onRoleCreate);
    socket.on(ServerEvents.ROLE_UPDATE, onRoleUpdate);
    socket.on(ServerEvents.ROLE_DELETE, onRoleDelete);
    socket.on(ServerEvents.SERVER_UPDATE, onServerUpdate);
    socket.on(ServerEvents.SERVER_DELETE, onServerDelete);
    socket.on(ServerEvents.DM_CREATE, onDMCreate);
    socket.on(ServerEvents.DM_UPDATE, onDMUpdate);
    // Same full-re-serialize shape as DM_UPDATE (just carries a new readStates array) — no
    // separate handler needed.
    socket.on(ServerEvents.DM_READ_UPDATE, onDMUpdate);
    socket.on(ServerEvents.DM_PARTICIPANT_REMOVED, onDMParticipantRemoved);
    socket.on(ServerEvents.VIDEO_STATUS_UPDATE, onVideoStatusUpdate);
    socket.on(ServerEvents.REPORT_RESOLVED, onReportResolved);
    socket.on(ServerEvents.PLATFORM_ROLE_UPDATE, onPlatformRoleUpdate);
    socket.on(ServerEvents.NOTIFICATION_MENTION, onMentionNotification);
    socket.on(ServerEvents.FRIEND_REQUEST_CREATE, onFriendRequestChange);
    socket.on(ServerEvents.FRIEND_REQUEST_UPDATE, onFriendRequestChange);
    socket.on(ServerEvents.VOICE_ROSTER_UPDATE, onVoiceRosterUpdate);

    return () => {
      socket.off(ServerEvents.APP_UPDATE_AVAILABLE, onAppUpdate);
      socket.off(ServerEvents.MESSAGE_CREATE, onMessageCreate);
      socket.off(ServerEvents.MESSAGE_UPDATE, onMessageUpdate);
      socket.off(ServerEvents.MESSAGE_DELETE, onMessageDelete);
      socket.off(ServerEvents.POLL_VOTE_UPDATE, onPollVote);
      socket.off(ServerEvents.MESSAGE_EMBEDS_UPDATE, onMessageEmbeds);
      socket.off(ServerEvents.REACTION_ADD);
      socket.off(ServerEvents.REACTION_REMOVE);
      socket.off(ServerEvents.TYPING_UPDATE, onTypingUpdate);
      socket.off(ServerEvents.PRESENCE_UPDATE, onPresenceUpdate);
      socket.off(ServerEvents.MEMBER_JOIN, onMemberJoin);
      socket.off(ServerEvents.MEMBER_UPDATE, onMemberUpdate);
      socket.off(ServerEvents.MEMBER_LEAVE, onMemberLeave);
      socket.off(ServerEvents.CHANNEL_CREATE, onChannelCreate);
      socket.off(ServerEvents.CHANNEL_UPDATE, onChannelUpdate);
      socket.off(ServerEvents.CHANNEL_DELETE, onChannelDelete);
      socket.off(ServerEvents.CHANNEL_OVERWRITES_UPDATE, onChannelOverwritesUpdate);
      socket.off(ServerEvents.THREAD_CREATE, onThreadChange);
      socket.off(ServerEvents.THREAD_UPDATE, onThreadChange);
      socket.off(ServerEvents.ROLE_CREATE, onRoleCreate);
      socket.off(ServerEvents.ROLE_UPDATE, onRoleUpdate);
      socket.off(ServerEvents.ROLE_DELETE, onRoleDelete);
      socket.off(ServerEvents.SERVER_UPDATE, onServerUpdate);
      socket.off(ServerEvents.SERVER_DELETE, onServerDelete);
      socket.off(ServerEvents.DM_CREATE, onDMCreate);
      socket.off(ServerEvents.DM_UPDATE, onDMUpdate);
      socket.off(ServerEvents.DM_READ_UPDATE, onDMUpdate);
      socket.off(ServerEvents.VIDEO_STATUS_UPDATE, onVideoStatusUpdate);
      socket.off(ServerEvents.PLATFORM_ROLE_UPDATE, onPlatformRoleUpdate);
      socket.off(ServerEvents.REPORT_RESOLVED, onReportResolved);
      socket.off(ServerEvents.DM_PARTICIPANT_REMOVED, onDMParticipantRemoved);
      socket.off(ServerEvents.NOTIFICATION_MENTION, onMentionNotification);
      socket.off(ServerEvents.FRIEND_REQUEST_CREATE, onFriendRequestChange);
      socket.off(ServerEvents.FRIEND_REQUEST_UPDATE, onFriendRequestChange);
      socket.off(ServerEvents.VOICE_ROSTER_UPDATE, onVoiceRosterUpdate);
    };
  }, [queryClient, currentUserId, setPresence, setTyping]);
}
