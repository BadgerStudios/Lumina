import { ServerEvents } from "@lumina/shared";
import { pushInboxNotification } from "../inbox/service.js";
import type { FriendDTO, FriendRequestDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { canContact, checkContact } from "../age/service.js";
import { assertNotLockedMinor, canContactWithApprovals } from "../parental/service.js";
import { recordFlag } from "../flags/service.js";
import { serializeFriendRequest, serializeUser } from "../../lib/serialize.js";
import { BadRequestError, BlockedError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { getIO } from "../../realtime/io.js";
import { sendPushToUser } from "../../lib/push.js";
import { invalidateSuggestions } from "./suggestions.js";

const requestInclude = { requester: true, addressee: true } as const;

function notifyCreated(dto: FriendRequestDTO): void {
  // Both parties' suggestion rankings just became wrong — each should stop seeing the other.
  void invalidateSuggestions(dto.requester.id, dto.addressee.id);
  getIO().to(`user:${dto.addressee.id}`).emit(ServerEvents.FRIEND_REQUEST_CREATE, dto);
  const name = dto.requester.displayName ?? dto.requester.username;
  void sendPushToUser(dto.addressee.id, {
    title: "New friend request",
    body: `${name} wants to be friends`,
    url: "/friends?tab=pending",
    tag: `friend-request-${dto.id}`,
  });
}

function notifyUpdated(dto: FriendRequestDTO): void {
  void invalidateSuggestions(dto.requester.id, dto.addressee.id);
  getIO().to(`user:${dto.requester.id}`).to(`user:${dto.addressee.id}`).emit(ServerEvents.FRIEND_REQUEST_UPDATE, dto);
}

/**
 * FriendRequest.requesterId/addresseeId had no @relation/FK at all before this module existed
 * (see schema.prisma) — this is the first code to ever touch the table.
 */
export async function sendFriendRequest(params: { requesterId: string; addresseeUsername: string }): Promise<FriendRequestDTO> {
  const addressee = await prisma.user.findUnique({ where: { username: params.addresseeUsername } });
  if (!addressee) throw new NotFoundError("User not found");
  if (addressee.id === params.requesterId) throw new BadRequestError("You can't send a friend request to yourself");
  if (addressee.isBot) throw new BadRequestError("Bots can't be friended");
  await assertNotLockedMinor(params.requesterId);

  // Adults and minors are kept apart. Checked here rather than only at the DM layer because a
  // friendship is the thing that unlocks most other contact, so allowing it and blocking messages
  // later would leave the connection half-formed and confusing for both people.
  const requester = await prisma.user.findUnique({
    where: { id: params.requesterId },
    // `id` is needed now that the contact decision can turn on a parent's approval of one
    // specific account, which is looked up by id rather than derived from the two ages.
    select: { id: true, isMinor: true, ageRecordedAt: true },
  });
  // Own missing age is its own outcome, not a contact restriction: it is the one thing the person
  // can fix, and BlockedError("AGE_MISSING") is what makes the client show the age prompt instead
  // of a refusal with no route out.
  if (requester && requester.ageRecordedAt === null) {
    void recordFlag({
      userId: params.requesterId,
      reasonCode: "AGE_MISSING",
      detail: "friend request blocked; age not on record",
    });
    throw new BlockedError("AGE_MISSING");
  }

  if (requester && checkContact(requester, addressee) === "unknown-other") {
    throw new ForbiddenError("That account hasn't finished setting up yet");
  }

  if (requester && !(await canContactWithApprovals(requester, addressee))) {
    void recordFlag({
      userId: params.requesterId,
      reasonCode: "AGE_CONTACT_RESTRICTED",
      detail: `friend request to ${addressee.id}`,
    });
    // Deliberately vague, and identical to the message an ordinary privacy block gives. Saying
    // "that person is a minor" would disclose a stranger's age to anyone who probed for it.
    throw new ForbiddenError("You can't send this person a friend request");
  }
  // Privacy & Safety setting (default true) — checked before the reverse-request auto-connect
  // below is even considered, since an existing reverse PENDING row already implies mutual
  // interest and shouldn't be blocked by this setting; only a *fresh* request from someone new
  // is what this setting is meant to stop.
  if (!addressee.allowFriendRequests) {
    const reverseExists = await prisma.friendRequest.findUnique({
      where: { requesterId_addresseeId: { requesterId: addressee.id, addresseeId: params.requesterId } },
    });
    if (!reverseExists || reverseExists.status !== "PENDING") {
      throw new ForbiddenError("This user isn't accepting friend requests");
    }
  }

  // If they already sent ME a pending request, connect the two instead of creating a second,
  // reversed row — matches the natural expectation that adding each other simultaneously just
  // makes you friends, not two dangling pending requests.
  const reverse = await prisma.friendRequest.findUnique({
    where: { requesterId_addresseeId: { requesterId: addressee.id, addresseeId: params.requesterId } },
  });
  if (reverse) {
    if (reverse.status === "BLOCKED") throw new ForbiddenError("You can't send a friend request to this user");
    if (reverse.status === "ACCEPTED") throw new ConflictError("Already friends");
    if (reverse.status === "PENDING" || reverse.status === "DECLINED") {
      // Conditional on the exact status just read, not a plain update-by-id: without this, two
      // concurrent calls racing this same reverse row (e.g. both sides tapping "add friend" at
      // once) could both pass the read-time checks above and both write, with the final state
      // decided by write order instead of by which call actually happened first — and both would
      // fire their own FRIEND_ACCEPT notification below regardless of which one "really" won.
      const { count } = await prisma.friendRequest.updateMany({
        where: { id: reverse.id, status: reverse.status },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      });
      if (count === 0) throw new ConflictError("This request just changed — try again");
      const updated = await prisma.friendRequest.findUniqueOrThrow({ where: { id: reverse.id }, include: requestInclude });
    void pushInboxNotification({
      userId: updated.requesterId,
      kind: "FRIEND_ACCEPT",
      bundleKey: `FRIEND_ACCEPT:${updated.id}`,
      actorId: updated.addresseeId,
      preview: "accepted your friend request",
    }).catch(() => undefined);
      const dto = serializeFriendRequest(updated);
      notifyUpdated(dto);
      return dto;
    }
  }

  const existing = await prisma.friendRequest.findUnique({
    where: { requesterId_addresseeId: { requesterId: params.requesterId, addresseeId: addressee.id } },
  });
  if (existing) {
    if (existing.status === "BLOCKED") throw new ForbiddenError("You can't send a friend request to this user");
    if (existing.status === "PENDING") throw new ConflictError("Friend request already sent");
    if (existing.status === "ACCEPTED") throw new ConflictError("Already friends");
    // DECLINED — allow resending rather than requiring the row to be deleted first.
    const updated = await prisma.friendRequest.update({
      where: { id: existing.id },
      data: { status: "PENDING", respondedAt: null },
      include: requestInclude,
    });
    const dto = serializeFriendRequest(updated);
    notifyCreated(dto);
    return dto;
  }

  const created = await prisma.friendRequest.create({
    data: { requesterId: params.requesterId, addresseeId: addressee.id, status: "PENDING" },
    include: requestInclude,
  });
  const dto = serializeFriendRequest(created);
  notifyCreated(dto);
  return dto;
}

export async function listMyFriendRequests(userId: string): Promise<{ incoming: FriendRequestDTO[]; outgoing: FriendRequestDTO[] }> {
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({ where: { addresseeId: userId, status: "PENDING" }, include: requestInclude, orderBy: { createdAt: "desc" } }),
    prisma.friendRequest.findMany({ where: { requesterId: userId, status: "PENDING" }, include: requestInclude, orderBy: { createdAt: "desc" } }),
  ]);
  return { incoming: incoming.map(serializeFriendRequest), outgoing: outgoing.map(serializeFriendRequest) };
}

/** `accept: false` covers both the addressee declining AND the requester cancelling their own
 * outgoing request — symmetric action, either side of a still-pending request can end it. */
export async function resolveFriendRequest(params: { userId: string; requestId: string; accept: boolean }): Promise<void> {
  const request = await prisma.friendRequest.findUnique({ where: { id: params.requestId } });
  if (!request) throw new NotFoundError("Friend request not found");
  if (request.status !== "PENDING") throw new BadRequestError("This request has already been resolved");

  // Both branches below write via a conditional updateMany rather than a plain update-by-id: the
  // status check above only holds at READ time. An addressee accepting while the requester
  // cancels in the same instant (or a double-tap) could otherwise both pass that check and both
  // write — final state decided by write order, not by which call actually happened first, and a
  // losing write would still fire its notification below as if it had applied.
  if (params.accept) {
    if (request.addresseeId !== params.userId) throw new ForbiddenError("Only the recipient can accept a friend request");
    const { count } = await prisma.friendRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    if (count === 0) throw new BadRequestError("This request has already been resolved");
    const updated = await prisma.friendRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
    notifyUpdated(serializeFriendRequest(updated));
    // The requester learns their request landed; the accepter already knows — they clicked it.
    void pushInboxNotification({
      userId: updated.requesterId,
      kind: "FRIEND_ACCEPT",
      bundleKey: `FRIEND_ACCEPT:${updated.id}`,
      actorId: updated.addresseeId,
      preview: "accepted your friend request",
    }).catch(() => undefined);
  } else {
    if (request.addresseeId !== params.userId && request.requesterId !== params.userId) {
      throw new ForbiddenError("Not your friend request");
    }
    const { count } = await prisma.friendRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: "DECLINED", respondedAt: new Date() },
    });
    if (count === 0) throw new BadRequestError("This request has already been resolved");
    const updated = await prisma.friendRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude });
    notifyUpdated(serializeFriendRequest(updated));
  }
}

export async function listMyFriends(userId: string): Promise<FriendDTO[]> {
  const rows = await prisma.friendRequest.findMany({
    where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { addresseeId: userId }] },
    include: requestInclude,
    orderBy: { respondedAt: "desc" },
  });
  return rows.map((r) => {
    const other = r.requesterId === userId ? r.addressee : r.requester;
    return { user: serializeUser(other), since: (r.respondedAt ?? r.createdAt).toISOString() };
  });
}

export async function removeFriend(params: { userId: string; otherUserId: string }): Promise<void> {
  const row = await prisma.friendRequest.findFirst({
    where: {
      status: "ACCEPTED",
      OR: [
        { requesterId: params.userId, addresseeId: params.otherUserId },
        { requesterId: params.otherUserId, addresseeId: params.userId },
      ],
    },
  });
  if (!row) throw new NotFoundError("Not friends with this user");
  await prisma.friendRequest.delete({ where: { id: row.id } });
  // Unfriending makes each of them a candidate for the other again — the stale ranking would
  // otherwise keep them out for up to the cache TTL.
  await invalidateSuggestions(params.userId, params.otherUserId);
}

/**
 * Blocks are always stored with the blocker as requesterId — a fixed, unambiguous convention
 * (not "whoever happened to be requester/addressee before") so `isBlockedEitherWay` and
 * `sendFriendRequest`'s existing BLOCKED checks (which already handled this status defensively
 * from day one, before anything actually produced it) work correctly without changes. Replaces
 * any prior row between the pair in either direction — a pending request or existing friendship
 * with someone you're about to block gets superseded, not left dangling.
 */
export async function blockUser(params: { blockerId: string; blockedUsername: string }): Promise<void> {
  const blocked = await prisma.user.findUnique({ where: { username: params.blockedUsername } });
  if (!blocked) throw new NotFoundError("User not found");
  if (blocked.id === params.blockerId) throw new BadRequestError("You can't block yourself");

  await prisma.$transaction([
    prisma.friendRequest.deleteMany({
      where: {
        OR: [
          { requesterId: params.blockerId, addresseeId: blocked.id },
          { requesterId: blocked.id, addresseeId: params.blockerId },
        ],
      },
    }),
    prisma.friendRequest.create({
      data: { requesterId: params.blockerId, addresseeId: blocked.id, status: "BLOCKED" },
    }),
  ]);
  await invalidateSuggestions(params.blockerId, blocked.id);
}

export async function unblockUser(params: { blockerId: string; blockedUserId: string }): Promise<void> {
  const row = await prisma.friendRequest.findUnique({
    where: { requesterId_addresseeId: { requesterId: params.blockerId, addresseeId: params.blockedUserId } },
  });
  if (!row || row.status !== "BLOCKED") throw new NotFoundError("Not blocking this user");
  await prisma.friendRequest.delete({ where: { id: row.id } });
  await invalidateSuggestions(params.blockerId, params.blockedUserId);
}

export async function listBlockedUsers(userId: string): Promise<FriendDTO[]> {
  const rows = await prisma.friendRequest.findMany({
    where: { requesterId: userId, status: "BLOCKED" },
    include: { addressee: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({ user: serializeUser(r.addressee), since: r.createdAt.toISOString() }));
}

/** Exported for modules/dm/routes.ts's allowDmsFromNonFriends check. */
export async function areFriends(userA: string, userB: string): Promise<boolean> {
  const row = await prisma.friendRequest.findFirst({
    where: {
      status: "ACCEPTED",
      OR: [
        { requesterId: userA, addresseeId: userB },
        { requesterId: userB, addresseeId: userA },
      ],
    },
    select: { id: true },
  });
  return !!row;
}

/** Exported for modules/dm/routes.ts — blocking someone who can still DM you isn't a real
 * block. Only meaningful for 1:1 DMs; group DM membership isn't blocked on this (matches most
 * chat apps: blocking stops new 1:1 contact, not being in the same group). */
export async function isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
  const row = await prisma.friendRequest.findFirst({
    where: {
      status: "BLOCKED",
      OR: [
        { requesterId: userA, addresseeId: userB },
        { requesterId: userB, addresseeId: userA },
      ],
    },
    select: { id: true },
  });
  return !!row;
}
