import type { ReportReason, ReportTargetType } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

/**
 * File a report against a USER or a MESSAGE.
 *
 * Videos have their own path (VideoReport); these two surfaces had none, so a user who was being
 * harassed in chat or a DM had nothing to click. Kept deliberately small — one open ticket per
 * reporter+target so re-reporting can't flood the queue, and the ticket stores scalar target ids
 * (ContentReport) so it survives the reported content being deleted.
 */
export async function submitContentReport(params: {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string;
}): Promise<{ id: string }> {
  const { reporterId, targetType, targetId, reason, details } = params;

  let targetUserId: string | null = null;
  let targetMessageId: bigint | null = null;

  if (targetType === "USER") {
    if (targetId === reporterId) throw new BadRequestError("You can't report yourself.");
    const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!user) throw new NotFoundError("That user doesn't exist.");
    targetUserId = targetId;
  } else {
    let messageId: bigint;
    try {
      messageId = BigInt(targetId);
    } catch {
      throw new BadRequestError("Invalid message id.");
    }
    const message = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, authorId: true } });
    if (!message) throw new NotFoundError("That message doesn't exist.");
    if (message.authorId && message.authorId === reporterId) throw new BadRequestError("You can't report your own message.");
    targetMessageId = messageId;
  }

  // One OPEN report per reporter+target: re-reporting the same thing shouldn't stack the queue.
  // (A composite unique index can't express this over nullable target columns — see the model.)
  const existing = await prisma.contentReport.findFirst({
    where: {
      reporterId,
      targetType,
      status: "OPEN",
      ...(targetUserId ? { targetUserId } : { targetMessageId }),
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id };

  const report = await prisma.contentReport.create({
    data: { reporterId, targetType, targetUserId, targetMessageId, reason, details: details ?? null },
    select: { id: true },
  });
  return { id: report.id };
}
