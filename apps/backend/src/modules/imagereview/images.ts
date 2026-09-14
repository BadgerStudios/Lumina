import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { banUser } from "../bans/service.js";

/**
 * Image review.
 *
 * Every image posted to Lumina lands here, newest work first, with reported ones ahead of the rest.
 * The queue is deliberately NOT a gate: an image is visible the moment it is sent, and this is the
 * sweep afterwards. Gating would mean nobody can share a screenshot until somebody has looked at
 * it, which is not a chat app.
 *
 * Removing is the one destructive action, and it does three things that have to stay together: the
 * row is marked REMOVED (so the serializer and the file route both refuse it), the bytes are
 * unlinked, and — if asked — the person who posted it is banned. A takedown that leaves the file
 * fetchable by anyone holding the id is not a takedown.
 */

export type ImageFilter = "pending" | "reported" | "removed" | "all";

/** Only actual images. The column is on every attachment so this can widen later without a migration. */
const IMAGE_MIME = { startsWith: "image/" } as const;

export interface ImageReviewRow {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  reviewStatus: "PENDING" | "APPROVED" | "REMOVED";
  reviewedAt: string | null;
  removalReason: string | null;
  /** Who posted it — the account a removal can ban. */
  author: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
  /** Where it was posted, in words, since a channel id tells a reviewer nothing. */
  location: string;
  messageId: string;
  messageContent: string;
  messageDeleted: boolean;
  /** Open reports naming the message this image is attached to. */
  reports: Array<{ id: string; reason: string; details: string | null; createdAt: string }>;
}

const OPEN_REPORT_STATUSES = ["OPEN", "IN_PROGRESS", "INVESTIGATING"] as const;

/**
 * Message ids with an open report against them.
 *
 * Fetched as a set and applied in memory rather than joined: ContentReport has no relation to
 * Message (it stores a bare `targetMessageId`), so there is nothing for Prisma to join on, and the
 * open-report count is small enough that the set is cheap. If that ever stops being true this
 * becomes a raw query rather than a different shape here.
 */
async function reportedMessageIds(): Promise<Map<bigint, ImageReviewRow["reports"]>> {
  const reports = await prisma.contentReport.findMany({
    where: { status: { in: [...OPEN_REPORT_STATUSES] }, targetMessageId: { not: null } },
    select: { id: true, targetMessageId: true, reason: true, details: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const byMessage = new Map<bigint, ImageReviewRow["reports"]>();
  for (const r of reports) {
    if (r.targetMessageId === null) continue;
    const list = byMessage.get(r.targetMessageId) ?? [];
    list.push({
      id: r.id,
      reason: r.reason,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    });
    byMessage.set(r.targetMessageId, list);
  }
  return byMessage;
}

function describeLocation(message: {
  channel: { name: string; server: { name: string } | null } | null;
  dmConversationId: string | null;
}): string {
  if (message.channel) {
    const server = message.channel.server?.name;
    return server ? `${server} · #${message.channel.name}` : `#${message.channel.name}`;
  }
  if (message.dmConversationId) return "Direct message";
  return "Unknown";
}

export async function listImages(params: {
  filter: ImageFilter;
  limit: number;
  cursor?: string;
}): Promise<{ images: ImageReviewRow[]; nextCursor: string | null; counts: { pending: number; reported: number } }> {
  const reported = await reportedMessageIds();

  // "reported" filters on the MESSAGE, not the attachment: ContentReport stores a bare
  // targetMessageId with no relation, so there is nothing to join on and the constraint is an id
  // list. An empty list correctly matches nothing — `in: []` returns no rows, where omitting the
  // clause would read as "no constraint" and return every image on the platform.
  const where: Prisma.AttachmentWhereInput = { mimeType: IMAGE_MIME };
  if (params.filter === "pending") where.reviewStatus = "PENDING";
  else if (params.filter === "removed") where.reviewStatus = "REMOVED";
  else if (params.filter === "reported") where.messageId = { in: [...reported.keys()] };
  // "all" adds nothing: every image, whatever has been decided about it.

  const rows = await prisma.attachment.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      message: {
        select: {
          id: true,
          content: true,
          deletedAt: true,
          dmConversationId: true,
          author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          channel: { select: { name: true, server: { select: { name: true } } } },
        },
      },
    },
  });

  const page = rows.slice(0, params.limit);
  const [pending, reportedPending] = await Promise.all([
    prisma.attachment.count({ where: { mimeType: IMAGE_MIME, reviewStatus: "PENDING" } }),
    prisma.attachment.count({
      where: { mimeType: IMAGE_MIME, reviewStatus: "PENDING", messageId: { in: [...reported.keys()] } },
    }),
  ]);

  return {
    images: page.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      url: a.url,
      width: a.width,
      height: a.height,
      createdAt: a.createdAt.toISOString(),
      reviewStatus: a.reviewStatus,
      reviewedAt: a.reviewedAt?.toISOString() ?? null,
      removalReason: a.removalReason,
      author: a.message.author,
      location: describeLocation(a.message),
      messageId: a.message.id.toString(),
      messageContent: a.message.content ?? "",
      messageDeleted: a.message.deletedAt !== null,
      reports: reported.get(a.message.id) ?? [],
    })),
    nextCursor: rows.length > params.limit ? page[page.length - 1]?.id ?? null : null,
    counts: { pending, reported: reportedPending },
  };
}

async function audit(actorId: string, actionType: string, targetId: string, reason: string | null) {
  await prisma.staffAuditLog.create({
    data: { actorId, actionType, targetType: "attachment", targetId, reason: reason?.slice(0, 300) ?? null },
  });
}

/** Cleared. The image stays exactly where it is and leaves the queue. */
export async function approveImage(id: string, actorId: string): Promise<void> {
  const attachment = await prisma.attachment.findUnique({ where: { id }, select: { reviewStatus: true } });
  if (!attachment) throw new NotFoundError("Image not found");
  if (attachment.reviewStatus === "REMOVED") throw new BadRequestError("That image has already been removed");

  await prisma.attachment.update({
    where: { id },
    data: { reviewStatus: "APPROVED", reviewedAt: new Date(), reviewedById: actorId },
  });
  await audit(actorId, "IMAGE_APPROVE", id, null);
}

export interface RemoveImageParams {
  id: string;
  actorId: string;
  reason: string;
  /**
   * Optionally ban whoever posted it, in the same action.
   *
   * `account` is the ban itself; the rest widen it to the identifiers that account is known by, so
   * a device ban is what stops the same phone signing up again. Omitted entirely, the image comes
   * down and nothing happens to the person — which is the right default for a first mistake.
   */
  ban?: { email: boolean; ip: boolean; device: boolean; reason?: string; days?: number | null };
}

export async function removeImage(params: RemoveImageParams): Promise<{ banned: boolean }> {
  const attachment = await prisma.attachment.findUnique({
    where: { id: params.id },
    select: { id: true, reviewStatus: true, message: { select: { authorId: true } } },
  });
  if (!attachment) throw new NotFoundError("Image not found");
  if (attachment.reviewStatus === "REMOVED") throw new BadRequestError("That image has already been removed");

  await prisma.attachment.update({
    where: { id: params.id },
    data: {
      reviewStatus: "REMOVED",
      reviewedAt: new Date(),
      reviewedById: params.actorId,
      removalReason: params.reason.slice(0, 500),
    },
  });

  // Unlink AFTER the row is marked, never before. If this throws, the image is already unreachable
  // through both the serializer and the file route, so the worst case is bytes left on disk that
  // nothing can ask for — the other order would leave a live row pointing at a missing file.
  try {
    await fs.unlink(path.join(env.UPLOADS_DIR, "attachments", params.id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.error(`[images] could not unlink ${params.id}:`, (err as Error)?.message);
    }
  }

  await audit(params.actorId, "IMAGE_REMOVE", params.id, params.reason);

  const authorId = attachment.message.authorId;
  if (!params.ban || !authorId) return { banned: false };

  // Banning the reviewer, or a bot, would be an own goal — and the owner's own account is reachable
  // from this screen like any other.
  if (authorId === params.actorId) throw new BadRequestError("That image is yours — removing it won't ban you");

  await banUser({
    userId: authorId,
    actorId: params.actorId,
    reason: params.ban.reason?.slice(0, 300) || params.reason.slice(0, 300),
    expiresAt: params.ban.days ? new Date(Date.now() + params.ban.days * 24 * 60 * 60 * 1000) : null,
    scopes: { email: params.ban.email, ip: params.ban.ip, device: params.ban.device },
  });
  await audit(params.actorId, "IMAGE_REMOVE_BAN", authorId, params.reason);
  return { banned: true };
}
