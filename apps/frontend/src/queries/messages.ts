import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageDTO } from "@lumina/shared";
import { api } from "../lib/apiClient";
import { queryKeys } from "../lib/queryKeys";
import { ClientEvents } from "@lumina/shared";
import { getSocket } from "../socket/socketClient";
import {
  patchMessageDelete,
  patchMessageUpdate,
  upsertMessageCreate,
  type MessagePages,
} from "../socket/cachePatches";

const PAGE_SIZE = 50;

// Backend cursor pagination (see channelMessagesRoutes.ts / lib/pagination.ts): messages are
// always fetched newest-first via an exclusive `before` cursor (a message id string) + `limit`.
// pageParam here IS that cursor: undefined for the first page, then the id of the oldest
// message seen so far to walk further into history.
export function useMessages(channelId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.messages(channelId ?? ""),
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) qs.set("before", pageParam as string);
      return api.get<MessageDTO[]>(`/channels/${channelId}/messages?${qs.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1].id : undefined),
    enabled: !!channelId,
  });
}

export function useDMMessages(conversationId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.dmMessages(conversationId ?? ""),
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) qs.set("before", pageParam as string);
      return api.get<MessageDTO[]>(`/dm/${conversationId}/messages?${qs.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1].id : undefined),
    enabled: !!conversationId,
  });
}

/** Fast path for plain-text sends: round-trips over the already-open socket (with ack)
 * instead of a REST call. Cache is patched via the ServerEvents.MESSAGE_CREATE broadcast
 * that every send (REST or socket) triggers server-side — see useSocketEvents.ts — but we
 * also patch here from the ack payload so the sender sees their own message immediately
 * even if the broadcast round-trip is slower than the ack. Both paths dedupe by message id. */
export function useSendChannelMessage(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; replyToId?: string | null }) =>
      new Promise<MessageDTO>((resolve, reject) => {
        getSocket().emit(
          ClientEvents.MESSAGE_SEND,
          { channelId, content: body.content, replyToId: body.replyToId ?? null },
          (res: { ok: true; data: MessageDTO } | { ok: false; error: string }) => {
            if (res.ok) resolve(res.data);
            else reject(new Error(res.error));
          },
        );
      }),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.messages(channelId), (old) => upsertMessageCreate(old, message));
    },
  });
}

export function useSendChannelMessageWithAttachments(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; replyToId?: string | null; files: File[] }) => {
      const form = new FormData();
      form.set("content", body.content);
      if (body.replyToId) form.set("replyToId", body.replyToId);
      for (const file of body.files) form.append("file", file, file.name);
      return api.postForm<MessageDTO>(`/channels/${channelId}/messages`, form);
    },
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.messages(channelId), (old) => upsertMessageCreate(old, message));
    },
  });
}

export function useSendDMMessage(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; replyToId?: string | null }) =>
      new Promise<MessageDTO>((resolve, reject) => {
        getSocket().emit(
          ClientEvents.MESSAGE_SEND,
          { conversationId, content: body.content, replyToId: body.replyToId ?? null },
          (res: { ok: true; data: MessageDTO } | { ok: false; error: string }) => {
            if (res.ok) resolve(res.data);
            else reject(new Error(res.error));
          },
        );
      }),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.dmMessages(conversationId), (old) => upsertMessageCreate(old, message));
    },
  });
}

/** REST (not socket) — same reasoning as useSendChannelMessageWithAttachments: a File can't
 * travel over a socket.io emit the way plain JSON can, so any attachment send goes through the
 * multipart POST /dm/:conversationId/messages route instead (see modules/messages/
 * dmMessagesRoutes.ts, which previously had no multipart handling at all — DM attachments never
 * worked). */
export function useSendDMMessageWithAttachments(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; replyToId?: string | null; files: File[] }) => {
      const form = new FormData();
      form.set("content", body.content);
      if (body.replyToId) form.set("replyToId", body.replyToId);
      for (const file of body.files) form.append("file", file, file.name);
      return api.postForm<MessageDTO>(`/dm/${conversationId}/messages`, form);
    },
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.dmMessages(conversationId), (old) => upsertMessageCreate(old, message));
    },
  });
}

/**
 * A send that carries something other than text or files — a sticker, or a poll.
 *
 * Separate from the two existing send hooks rather than folded into them, because the socket fast
 * path cannot carry either: a poll has to be *created* server-side inside the same request that
 * creates its message (see modules/messages/channelMessagesRoutes.ts), so this is REST-only by
 * construction. Keeping it apart means the plain-text path stays on the socket, which is where the
 * latency actually matters.
 */
export interface RichSendPayload {
  content: string;
  replyToId?: string | null;
  stickerId?: string | null;
  poll?: { question: string; options: string[]; allowMultiple?: boolean; durationHours?: number | null } | null;
}

function richForm(payload: RichSendPayload): FormData {
  const form = new FormData();
  form.set("content", payload.content);
  if (payload.replyToId) form.set("replyToId", payload.replyToId);
  if (payload.stickerId) form.set("stickerId", payload.stickerId);
  // JSON in a multipart field: a form field is a string, and the poll definition is a tree.
  if (payload.poll) form.set("poll", JSON.stringify(payload.poll));
  return form;
}

export function useSendChannelMessageRich(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RichSendPayload) =>
      api.postForm<MessageDTO>(`/channels/${channelId}/messages`, richForm(payload)),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.messages(channelId), (old) => upsertMessageCreate(old, message));
    },
  });
}

export function useSendDMMessageRich(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RichSendPayload) =>
      api.postForm<MessageDTO>(`/dm/${conversationId}/messages`, richForm(payload)),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(queryKeys.dmMessages(conversationId), (old) =>
        upsertMessageCreate(old, message),
      );
    },
  });
}

function messageQueryKeyFor(message: MessageDTO): readonly unknown[] {
  return message.channelId ? queryKeys.messages(message.channelId) : queryKeys.dmMessages(message.dmConversationId!);
}

export function useEditMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, content }: { messageId: string; content: string }) =>
      api.patch<MessageDTO>(`/messages/${messageId}`, { content }),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(messageQueryKeyFor(message), (old) => patchMessageUpdate(old, message));
    },
  });
}

export function useDeleteMessage(target: { channelId?: string; dmConversationId?: string }) {
  const queryClient = useQueryClient();
  const key = target.channelId ? queryKeys.messages(target.channelId) : queryKeys.dmMessages(target.dmConversationId!);
  return useMutation({
    mutationFn: (messageId: string) => api.delete<void>(`/messages/${messageId}`),
    onSuccess: (_data, messageId) => {
      queryClient.setQueryData<MessagePages>(key, (old) => patchMessageDelete(old, messageId));
    },
  });
}

/** Backs the pinned-messages panel (components/chat/PinnedMessagesModal.tsx). `pinned` was
 * already a MessageDTO field with zero call sites — see modules/messages/service.ts. */
export function usePinnedMessages(channelId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.messages(channelId ?? ""), "pins"] as const,
    queryFn: () => api.get<MessageDTO[]>(`/channels/${channelId}/pins`),
    enabled: !!channelId && enabled,
  });
}

export function useTogglePinMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, pinned }: { messageId: string; pinned: boolean }) =>
      api.patch<MessageDTO>(`/messages/${messageId}/pin`, { pinned }),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePages>(messageQueryKeyFor(message), (old) => patchMessageUpdate(old, message));
      if (message.channelId) {
        queryClient.invalidateQueries({ queryKey: [...queryKeys.messages(message.channelId), "pins"] });
      }
    },
  });
}

export function useAddReaction() {
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      new Promise<void>((resolve, reject) => {
        getSocket().emit(ClientEvents.REACTION_ADD, { messageId, emoji }, (res: { ok: boolean; error?: string }) => {
          if (res.ok) resolve();
          else reject(new Error(res.error ?? "Failed to add reaction"));
        });
      }),
    // No cache patch here: the ServerEvents.REACTION_ADD broadcast (which the server sends
    // to the sender too, since they're in the room) is what drives the UI update — see
    // useSocketEvents.ts. Avoids double-counting since the ack has no message-scoped payload.
  });
}

export function useRemoveReaction() {
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      new Promise<void>((resolve, reject) => {
        getSocket().emit(ClientEvents.REACTION_REMOVE, { messageId, emoji }, (res: { ok: boolean; error?: string }) => {
          if (res.ok) resolve();
          else reject(new Error(res.error ?? "Failed to remove reaction"));
        });
      }),
  });
}
