import { useEffect, useRef, useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { DMConversationDTO, MessageDTO } from "@lumina/shared";
import { MessageItem } from "./MessageItem";
import { UserAvatar } from "../common/UserAvatar";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function MessageList({
  data,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  canManage,
  currentUserId,
  onEdit,
  onDelete,
  onReply,
  onReact,
  onUnreact,
  onTogglePin,
  dmReadStates,
  dmParticipants,
}: {
  data: InfiniteData<MessageDTO[]> | undefined;
  isLoading: boolean;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  canManage: boolean;
  currentUserId: string | undefined;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onReply: (message: MessageDTO) => void;
  onReact: (messageId: string, emoji: string) => void;
  onUnreact: (messageId: string, emoji: string) => void;
  onTogglePin?: (messageId: string, pinned: boolean) => void;
  // DM-only — see DMRoute.tsx. Undefined in channel context, where read receipts don't exist.
  dmReadStates?: DMConversationDTO["readStates"];
  dmParticipants?: DMConversationDTO["participants"];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Pages are newest-first (see queries/messages.ts); reverse to oldest-first for top-to-bottom
  // chat rendering, and reverse the page order too since page 0 = newest page.
  const ordered = data ? [...data.pages].reverse().flatMap((page) => [...page].reverse()) : [];

  const prevLastId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = ordered[ordered.length - 1]?.id;
    const el = scrollRef.current;
    if (!el) return;
    if (last !== prevLastId.current) {
      prevLastId.current = last;
      if (autoScroll) {
        el.scrollTop = el.scrollHeight;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered.length]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setAutoScroll(nearBottom);
    if (el.scrollTop < 80 && hasNextPage && !isFetchingNextPage) {
      const prevHeight = el.scrollHeight;
      fetchNextPage();
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight;
      });
    }
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto py-3">
      {isLoading ? (
        <div className="flex h-full items-center justify-center text-sm text-signal-faint">Loading messages…</div>
      ) : ordered.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-signal-faint">No messages yet. Say hello!</div>
      ) : (
        <>
          {isFetchingNextPage && <div className="py-2 text-center text-xs text-signal-faint">Loading older messages…</div>}
          {ordered.map((message, i) => {
            const prev = ordered[i - 1];
            const showHeader =
              !prev ||
              prev.authorId !== message.authorId ||
              new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() > GROUP_WINDOW_MS;
            return (
              <MessageItem
                key={message.id}
                message={message}
                showHeader={showHeader}
                canManage={canManage}
                currentUserId={currentUserId}
                onEdit={onEdit}
                onDelete={onDelete}
                onReply={onReply}
                onReact={onReact}
                onUnreact={onUnreact}
                onTogglePin={onTogglePin}
              />
            );
          })}
          {dmReadStates && dmParticipants ? <SeenIndicator messages={ordered} readStates={dmReadStates} participants={dmParticipants} currentUserId={currentUserId} /> : null}
        </>
      )}
    </div>
  );
}

/** DM-only "Seen" line under the most recent message everyone else has read up to — mirrors the
 * DMParticipant.lastReadMessageId written by PATCH /api/dm/:id/read. Message ids are sequential
 * bigints (see schema.prisma), compared as BigInt since they're carried as strings over the
 * wire (JSON has no bigint type). */
function SeenIndicator({
  messages,
  readStates,
  participants,
  currentUserId,
}: {
  messages: MessageDTO[];
  readStates: DMConversationDTO["readStates"];
  participants: DMConversationDTO["participants"];
  currentUserId: string | undefined;
}) {
  if (messages.length === 0) return null;
  const others = participants.filter((p) => p.id !== currentUserId);
  if (others.length === 0) return null;

  // For each other participant, find the newest message THEY'VE read (their lastReadMessageId),
  // then only show participants who've read at least the most recent message someone sent.
  const latestMessageId = BigInt(messages[messages.length - 1].id);
  const seenBy = others.filter((p) => {
    const state = readStates.find((r) => r.userId === p.id);
    if (!state?.lastReadMessageId) return false;
    return BigInt(state.lastReadMessageId) >= latestMessageId;
  });
  if (seenBy.length === 0) return null;

  return (
    <div className="flex items-center justify-end gap-1 px-4 pt-1 text-[10px] text-signal-faint">
      <div className="flex -space-x-1.5">
        {seenBy.slice(0, 3).map((p) => (
          <UserAvatar key={p.id} avatarUrl={p.avatarUrl} name={p.displayName ?? p.username} size={14} />
        ))}
      </div>
      Seen
    </div>
  );
}
