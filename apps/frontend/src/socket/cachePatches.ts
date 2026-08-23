// Pure cache-patch functions — no React, no TanStack Query import, no socket import.
// Each function takes "old cache data" + "event payload" and returns "new cache data",
// exactly like a reducer. This is what useSocketEvents.ts calls from its ServerEvents.*
// listeners (via queryClient.setQueryData(key, (old) => patchFn(old, payload))), and it's
// also what mutation onSuccess handlers call for the initiating client's own action — so
// cache shape stays correct whether a change arrives via REST response or socket broadcast,
// and it's exactly what apps/frontend/scripts/verify-realtime.mjs unit-tests directly
// against real payloads captured from the live backend, without mounting any React tree.
import type { ChannelDTO, LinkPreviewDTO, MemberDTO, MessageDTO, PollDTO, ReactionSummaryDTO, RoleDTO } from "@lumina/shared";

export interface InfinitePages<T> {
  pages: T[][];
  pageParams: unknown[];
}

export type MessagePages = InfinitePages<MessageDTO> | undefined;

function idBig(id: string): bigint {
  return BigInt(id);
}

/** message:create — unshift into the newest (first) page, deduping by id (covers an event
 * arriving twice, e.g. once via optimistic REST response and again via socket broadcast). */
export function upsertMessageCreate(data: MessagePages, message: MessageDTO): MessagePages {
  if (!data || data.pages.length === 0) {
    return { pages: [[message]], pageParams: [undefined] };
  }
  const alreadyPresent = data.pages.some((page) => page.some((m) => m.id === message.id));
  if (alreadyPresent) {
    return patchMessageUpdate(data, message);
  }
  const [firstPage, ...restPages] = data.pages;
  const newFirstPage = [message, ...firstPage].sort((a, b) => (idBig(b.id) > idBig(a.id) ? 1 : idBig(b.id) < idBig(a.id) ? -1 : 0));
  return { ...data, pages: [newFirstPage, ...restPages] };
}

/** message:update — replace the message with matching id wherever it appears. */
export function patchMessageUpdate(data: MessagePages, message: MessageDTO): MessagePages {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => page.map((m) => (m.id === message.id ? message : m))),
  };
}

/** message:delete — remove the message with matching id wherever it appears (soft-delete on
 * the backend, so it simply drops out of the list rather than showing a tombstone). */
export function patchMessageDelete(data: MessagePages, messageId: string): MessagePages {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => page.filter((m) => m.id !== messageId)),
  };
}

export interface ReactionEventPayload {
  messageId: string;
  emoji: string;
  userId: string;
  count: number;
}

/** reaction:add / reaction:remove — patch just the affected message's reactions summary
 * array in place. `isAdd` distinguishes the two event types since payload shape is identical. */
export function patchReaction(
  data: MessagePages,
  payload: ReactionEventPayload,
  isAdd: boolean,
  currentUserId: string | undefined,
): MessagePages {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.map((m) => {
        if (m.id !== payload.messageId) return m;
        const existing = m.reactions.find((r) => r.emoji === payload.emoji);
        const reactedByMe =
          payload.userId === currentUserId ? isAdd : (existing?.reactedByMe ?? false);
        let reactions: ReactionSummaryDTO[];
        if (payload.count <= 0) {
          reactions = m.reactions.filter((r) => r.emoji !== payload.emoji);
        } else if (existing) {
          reactions = m.reactions.map((r) =>
            r.emoji === payload.emoji ? { ...r, count: payload.count, reactedByMe } : r,
          );
        } else {
          reactions = [...m.reactions, { emoji: payload.emoji, count: payload.count, reactedByMe }];
        }
        return { ...m, reactions };
      }),
    ),
  };
}

// ---- Plain-array list caches (members / channels / roles) ----

export function upsertById<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  if (!list) return [item];
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

export function removeById<T extends { id: string }>(list: T[] | undefined, id: string): T[] | undefined {
  return list?.filter((x) => x.id !== id);
}

export function upsertMember(list: MemberDTO[] | undefined, member: MemberDTO): MemberDTO[] {
  if (!list) return [member];
  const idx = list.findIndex((m) => m.userId === member.userId);
  if (idx === -1) return [...list, member];
  const next = [...list];
  next[idx] = member;
  return next;
}

export function removeMember(list: MemberDTO[] | undefined, userId: string): MemberDTO[] | undefined {
  return list?.filter((m) => m.userId !== userId);
}

export function upsertChannel(list: ChannelDTO[] | undefined, channel: ChannelDTO): ChannelDTO[] {
  return upsertById(list, channel).sort((a, b) => a.position - b.position);
}

export function upsertRole(list: RoleDTO[] | undefined, role: RoleDTO): RoleDTO[] {
  return upsertById(list, role).sort((a, b) => a.position - b.position);
}

export interface PollVotePayload {
  messageId: string;
  voterId: string;
  poll: PollDTO;
}

/**
 * poll:vote-update — replaces the poll on one message.
 *
 * The broadcast is serialized once for a whole room, so every option in it comes back with
 * `votedByMe: false`. Recomputing that flag here from `voterId` is what makes the payload usable:
 * the person who voted sets their own ticks from the event, everyone else keeps whatever they
 * already had. The alternative — trusting the payload — would silently clear every viewer's own
 * ticks each time anyone else voted.
 */
export function patchPollVote(data: MessagePages, payload: PollVotePayload, _currentUserId: string | undefined): MessagePages {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.map((m) => {
        if (m.id !== payload.messageId || !m.poll) return m;
        const previous = new Map(m.poll.options.map((o) => [o.id, o.votedByMe]));
        return {
          ...m,
          poll: {
            ...payload.poll,
            options: payload.poll.options.map((o) => ({
              ...o,
              // votedByMe is preserved from the local cache for EVERYONE, including the voter — the
              // broadcast payload is serialized with no viewer so its votedByMe is always false.
              // The old `isMine` branch trusted that false for the voter, which un-ticked their own
              // selection a beat after the optimistic REST update ticked it. The voter's own choice
              // is authoritatively tracked by that optimistic mutation, not by this echo; take the
              // fresh counts from the payload and keep every votedByMe flag from what's already here.
              votedByMe: previous.get(o.id) ?? false,
            })),
          },
        };
      }),
    ),
  };
}

export interface EmbedsPayload {
  messageId: string;
  embeds: LinkPreviewDTO[];
}

/** message:embeds-update — link unfurls, which land a second or two after the message did. */
export function patchMessageEmbeds(data: MessagePages, payload: EmbedsPayload): MessagePages {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.map((m) => (m.id === payload.messageId ? { ...m, embeds: payload.embeds } : m)),
    ),
  };
}
