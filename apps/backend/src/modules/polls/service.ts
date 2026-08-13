import { Permissions, ServerEvents } from "@lumina/shared";
import type { PollDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { serializePoll } from "../../lib/serialize.js";
import { checkPermission } from "../../permissions/permissionService.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { getIO } from "../../realtime/io.js";

/**
 * Polls.
 *
 * A poll is created *with* its message, in one transaction, by the normal send path — there is no
 * "create a poll then attach it" flow. That is deliberate: an orphan Poll row with no message would
 * be invisible and unreachable, and a two-step create is exactly how you get them.
 */

export const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;
/** A month. Long enough for anything anyone actually runs a poll for. */
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreatePollInput {
  question: string;
  options: string[];
  allowMultiple?: boolean;
  durationHours?: number | null;
}

/** Validates and creates the Poll rows. Returns the id for the message that will carry it. */
export async function createPoll(input: CreatePollInput): Promise<string> {
  const question = input.question.trim();
  if (!question) throw new BadRequestError("A poll needs a question");
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new BadRequestError(`Poll question must be ${MAX_QUESTION_LENGTH} characters or fewer`);
  }

  const options = input.options.map((o) => o.trim()).filter((o) => o.length > 0);
  if (options.length < 2) throw new BadRequestError("A poll needs at least two options");
  if (options.length > MAX_OPTIONS) throw new BadRequestError(`A poll can have at most ${MAX_OPTIONS} options`);
  if (options.some((o) => o.length > MAX_OPTION_LENGTH)) {
    throw new BadRequestError(`Each option must be ${MAX_OPTION_LENGTH} characters or fewer`);
  }
  // Case-insensitive, because two options that read identically are indistinguishable to a voter
  // no matter how they are capitalised.
  const seen = new Set(options.map((o) => o.toLowerCase()));
  if (seen.size !== options.length) throw new BadRequestError("Poll options must be different from each other");

  let expiresAt: Date | null = null;
  if (input.durationHours != null) {
    const ms = input.durationHours * 60 * 60 * 1000;
    if (!Number.isFinite(ms) || ms <= 0) throw new BadRequestError("Poll duration must be positive");
    if (ms > MAX_DURATION_MS) throw new BadRequestError("A poll can run for at most 30 days");
    expiresAt = new Date(Date.now() + ms);
  }

  const poll = await prisma.poll.create({
    data: {
      question,
      allowMultiple: input.allowMultiple === true,
      expiresAt,
      options: { create: options.map((label, position) => ({ label, position })) },
    },
  });
  return poll.id;
}

/**
 * Casts (or retracts) a vote.
 *
 * The whole thing runs in one transaction because a single-select vote is a delete-then-insert, and
 * a crash between the two would leave the voter with no vote at all in a poll they had already
 * voted in — a state they could not tell apart from "my click didn't register".
 */
export async function votePoll(params: { userId: string; pollId: string; optionId: string }): Promise<PollDTO> {
  const poll = await prisma.poll.findUnique({
    where: { id: params.pollId },
    include: { options: true, messages: { select: { id: true, channelId: true, dmConversationId: true } } },
  });
  if (!poll) throw new NotFoundError("Poll not found");

  const option = poll.options.find((o) => o.id === params.optionId);
  if (!option) throw new BadRequestError("That option is not part of this poll");

  if (poll.expiresAt && poll.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError("This poll has closed");
  }

  // The message carries the poll's location, and the location is what decides who may vote. A poll
  // with no message cannot be voted in at all — see the note at the top about orphans.
  const message = poll.messages[0];
  if (!message) throw new NotFoundError("Poll not found");
  await assertCanVoteHere(params.userId, message);

  const existing = await prisma.pollVote.findUnique({
    where: { optionId_userId: { optionId: params.optionId, userId: params.userId } },
  });

  await prisma.$transaction(async (tx) => {
    if (existing) {
      // Clicking your own choice again retracts it. Idempotent-feeling and the only way to undo a
      // misclick in a single-select poll, which otherwise locks you into the first thing you hit.
      await tx.pollVote.delete({
        where: { optionId_userId: { optionId: params.optionId, userId: params.userId } },
      });
      return;
    }
    if (!poll.allowMultiple) {
      // Single-select: the previous choice goes before the new one lands. Enforced here rather
      // than by a constraint, because a multi-select poll legitimately has several rows per user
      // per poll and one schema has to serve both.
      await tx.pollVote.deleteMany({ where: { pollId: params.pollId, userId: params.userId } });
    }
    await tx.pollVote.create({
      data: { pollId: params.pollId, optionId: params.optionId, userId: params.userId },
    });
  });

  const updated = await prisma.poll.findUniqueOrThrow({
    where: { id: params.pollId },
    include: { options: { include: { votes: { select: { userId: true } } } } },
  });

  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmConversationId}`;
  // Serialized with no viewer, so `votedByMe` is false for everyone in the payload — each client
  // sets its own flag by comparing voterId to itself, exactly as REACTION_ADD already works.
  getIO().to(room).emit(ServerEvents.POLL_VOTE_UPDATE, {
    messageId: message.id.toString(),
    voterId: params.userId,
    poll: serializePoll(updated, null),
  });

  return serializePoll(updated, params.userId);
}

async function assertCanVoteHere(
  userId: string,
  message: { channelId: string | null; dmConversationId: string | null },
): Promise<void> {
  if (message.channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: message.channelId },
      select: { serverId: true },
    });
    if (!channel) throw new NotFoundError("Poll not found");
    // VIEW_CHANNELS, not SEND_MESSAGES: voting is not posting, and a read-only announcement channel
    // running a poll is a legitimate thing to want.
    await checkPermission(userId, channel.serverId, Permissions.VIEW_CHANNELS);
    return;
  }
  if (message.dmConversationId) {
    const participant = await prisma.dMParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.dmConversationId, userId } },
    });
    if (!participant) throw new ForbiddenError("Not a participant in this conversation");
    return;
  }
  throw new NotFoundError("Poll not found");
}
