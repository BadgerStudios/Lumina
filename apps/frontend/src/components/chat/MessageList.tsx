import { usePreferencesStore } from "../../store/preferencesStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { DMConversationDTO, MessageDTO } from "@lumina/shared";
import { ArrowDown } from "lucide-react";
import { MessageItem } from "./MessageItem";
import { UserAvatar } from "../common/UserAvatar";
import { ICON } from "../common/Icon";
import { SkeletonList } from "../common/Skeleton";
import { useUIStore } from "../../store/uiStore";
import { cn } from "../../lib/cn";

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
  onOpenThread,
  onStartThread,
  focusMessageId,
  focusNonce,
  lastReadMessageId,
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
  onOpenThread?: (threadId: string) => void;
  onStartThread?: (message: MessageDTO) => void;
  // Jump-to-message: the id to scroll to and briefly highlight. focusNonce lets the same id be
  // re-jumped (e.g. clicking the same link twice) since the id alone wouldn't change.
  focusMessageId?: string | null;
  focusNonce?: number;
  // The reader's last-read message id for this room, captured when the room was entered — the
  // "New messages" divider goes immediately after it. Absent means no divider.
  lastReadMessageId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Snapshot the read cursor so the divider stays where it was while you read: the room's own
  // auto-read keeps advancing the real cursor, and a divider that followed it would walk down the
  // page ahead of you. Re-anchors only when the caller hands over a different cursor.
  const [unreadAnchorId, setUnreadAnchorId] = useState<string | null>(lastReadMessageId ?? null);
  const lastReadSeen = useRef<string | null | undefined>(lastReadMessageId);
  useEffect(() => {
    if (lastReadMessageId === lastReadSeen.current) return;
    lastReadSeen.current = lastReadMessageId;
    setUnreadAnchorId(lastReadMessageId ?? null);
  }, [lastReadMessageId]);
  // The compact density setting had no effect at all before this: the CSS that implements it keys
  // off a `density-compact` class on this scroller, and nothing had ever added it.
  const density = useUIStore((s) => s.density);

  // Pages are newest-first (see queries/messages.ts); reverse to oldest-first for top-to-bottom
  // chat rendering, and reverse the page order too since page 0 = newest page.
  const showJoinLeaveLines = usePreferencesStore((s) => s.prefs.chat.showJoinLeaveLines);
  const orderedAll = data ? [...data.pages].reverse().flatMap((page) => [...page].reverse()) : [];
  // Account preference: the space's join/leave lines can be hidden without hiding anyone's words.
  const ordered = showJoinLeaveLines ? orderedAll : orderedAll.filter((m) => m.type === "DEFAULT");

  // Index of the first message newer than the read cursor — where the divider goes. Ids are
  // sequential bigints carried as strings, the same comparison SeenIndicator below makes.
  const unreadIndex = useMemo(() => {
    if (!unreadAnchorId) return -1;
    let cursor: bigint;
    try {
      cursor = BigInt(unreadAnchorId);
    } catch {
      return -1;
    }
    return ordered.findIndex((m) => {
      try {
        return BigInt(m.id) > cursor;
      } catch {
        return false;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered.length, unreadAnchorId]);
  // Show the divider only when a read message actually precedes the first unread one in the loaded
  // window, or when everything is unread and there is no older page above. Otherwise the true
  // boundary is off-screen above and a divider pinned to the top would be a lie.
  const showUnreadDivider = unreadIndex >= 1 || (unreadIndex === 0 && !hasNextPage);

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

  // Scroll to and flash a message. It may not be in the DOM yet — the parent seeds the cache
  // first, then bumps focusNonce, so the render lands a tick later; retry across a few frames
  // until the row exists, then centre it and flash it for a couple of seconds.
  //
  // Returns a cleanup so the effect below can cancel a retry loop mid-flight; the reply quote
  // calls it directly and ignores the return.
  const focusMessage = useCallback((messageId: string) => {
    setAutoScroll(false);
    let tries = 0;
    let raf = 0;
    let clearTimer = 0;
    const tick = () => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        setHighlightId(messageId);
        clearTimer = window.setTimeout(() => setHighlightId((cur) => (cur === messageId ? null : cur)), 2200);
        return;
      }
      if (tries++ < 40) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(clearTimer);
    };
  }, []);

  useEffect(() => {
    if (!focusMessageId) return;
    return focusMessage(focusMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, focusNonce]);

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

  function jumpToPresent() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }

  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={cn("h-full overflow-y-auto py-3", density === "compact" && "density-compact")}
    >
      {isLoading ? (
        <SkeletonList rows={8} />
      ) : ordered.length === 0 ? (
        <div role="status" className="flex h-full items-center justify-center text-sm text-signal-faint">
          No messages yet. Say hello!
        </div>
      ) : (
        <>
          {isFetchingNextPage && (
            <div role="status" className="py-2 text-center text-xs text-signal-faint">
              Loading older messages…
            </div>
          )}
          {ordered.map((message, i) => {
            const prev = ordered[i - 1];
            const showHeader =
              !prev ||
              prev.authorId !== message.authorId ||
              // An announcement never starts a group: the member's first real message after their
              // own join line must carry its own name and face.
              message.type !== "DEFAULT" ||
              prev.type !== "DEFAULT" ||
              new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() > GROUP_WINDOW_MS;
            return (
              <div key={message.id}>
                {showUnreadDivider && i === unreadIndex ? <UnreadDivider /> : null}
              <MessageItem
                message={message}
                showHeader={showHeader}
                highlighted={message.id === highlightId}
                canManage={canManage}
                currentUserId={currentUserId}
                onEdit={onEdit}
                onDelete={onDelete}
                onReply={onReply}
                onReact={onReact}
                onUnreact={onUnreact}
                onTogglePin={onTogglePin}
                onOpenThread={onOpenThread}
                onStartThread={onStartThread}
                onJumpToMessage={focusMessage}
              />
              </div>
            );
          })}
          {dmReadStates && dmParticipants ? <SeenIndicator messages={ordered} readStates={dmReadStates} participants={dmParticipants} currentUserId={currentUserId} /> : null}
        </>
      )}
    </div>

      {/* Appears only once you have scrolled up away from the live edge. */}
      {!autoScroll && ordered.length > 0 ? (
        <button
          type="button"
          onClick={jumpToPresent}
          className="lm-pop lx-focus absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full border border-hairline bg-base-800 px-3 py-1.5 text-xs font-medium text-signal shadow-lg transition hover:bg-base-700"
        >
          <ArrowDown size={ICON.xs} /> Jump to present
        </button>
      ) : null}
    </div>
  );
}

/** A slim separator marking where the reader left off. */
function UnreadDivider() {
  return (
    <div className="my-1 flex items-center gap-2 px-4" role="separator" aria-label="New messages">
      <div className="h-px flex-1 bg-accent/40" />
      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold uppercase tracking-wide text-accent">
        New
      </span>
      <div className="h-px flex-1 bg-accent/40" />
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
