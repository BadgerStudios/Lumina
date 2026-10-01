import type { ReportStatus, TicketCategory } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { notifyStaffOfQueueItem } from "./notifyStaff.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { serializeVideoWithStatus, VIDEO_AUTHOR_SELECT, VIDEO_TAGS_INCLUDE, VIDEO_SOURCE_INCLUDE } from "../videos/serialize.js";
import type { VideoDTO } from "@lumina/shared";

/**
 * One queue for everything a moderator works.
 *
 * ## Why a reference instead of an id
 *
 * A ticket is a row in one of two tables. VideoReport has a working lifecycle, a leaderboard and
 * reporter ratings built on it; ContentReport is now the general ticket table and covers user,
 * message and image reports, system flags and support requests. Merging them would mean migrating
 * live data for no behavioural gain, so every ticket is addressed by a namespaced reference —
 * `v:<id>` or `c:<id>` — and this module is the only place that knows which is which.
 *
 * ## Avatars are joined, never copied
 *
 * Cards show each person's CURRENT picture because it is read from the User row at request time.
 * Worth stating because the tempting optimisation — denormalising an avatar URL onto the ticket
 * when it is filed — is exactly what leaves a queue full of months-old profile pictures.
 */

export type TicketKind = "message" | "video" | "image" | "user" | "support";

interface Person {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

const PERSON = { id: true, username: true, displayName: true, avatarUrl: true } as const;

export interface TicketCard {
  ref: string;
  category: TicketCategory;
  kind: TicketKind;
  status: ReportStatus;
  /** The one line that has to carry the card. */
  subject: string;
  detail: string | null;
  createdAt: string;
  /** Whose picture the card shows: the person who filed it, or asked for help. */
  person: Person | null;
  /** Who it is ABOUT, when that is somebody else. Null for support and most system flags. */
  about: Person | null;
  assignedTo: Person | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  replyCount: number;
  lastReplyAt: string | null;
}

type Lookup = (id: string | null) => Person | null;
type Reply = { count: number; last: Date | null } | undefined;

/** Human wording for a reason code, so a card never shows SEXUAL_CONTENT in caps. */
function phrase(reason: string): string {
  return reason.replace(/_/g, " ").toLowerCase();
}

function splitRef(ref: string): { table: "content" | "video"; id: string } {
  const [prefix, ...rest] = ref.split(":");
  const id = rest.join(":");
  if (!id) throw new BadRequestError("Malformed ticket reference");
  if (prefix === "c") return { table: "content", id };
  if (prefix === "v") return { table: "video", id };
  throw new BadRequestError("Unknown ticket reference");
}

async function replyCounts(refs: string[]): Promise<Map<string, { count: number; last: Date | null }>> {
  if (refs.length === 0) return new Map();
  const grouped = await prisma.ticketMessage.groupBy({
    by: ["ticketRef"],
    where: { ticketRef: { in: refs } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  return new Map(grouped.map((g) => [g.ticketRef, { count: g._count._all, last: g._max.createdAt }]));
}

type ContentRow = Awaited<ReturnType<typeof prisma.contentReport.findFirstOrThrow>>;
type VideoRow = {
  id: string;
  reason: string;
  details: string | null;
  status: ReportStatus;
  createdAt: Date;
  reporterId: string | null;
  assignedToId: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  video: { caption: string | null; author: Person | null };
};

function buildContentCard(r: ContentRow, who: Lookup, reply: Reply): TicketCard {
  const kind: TicketKind =
    r.targetType === "MESSAGE"
      ? "message"
      : r.targetType === "ATTACHMENT"
        ? "image"
        : r.targetType === "USER"
          ? "user"
          : "support";
  return {
    ref: `c:${r.id}`,
    category: r.category,
    kind,
    status: r.status,
    // A stored subject wins — it is the only thing a support ticket has. Reports get a sentence
    // built from what they are about, so no card ever reads as a bare reason code.
    subject:
      r.subject ??
      (kind === "support"
        ? "Support request"
        : kind === "message"
          ? `Message reported for ${phrase(r.reason)}`
          : kind === "image"
            ? `Image reported for ${phrase(r.reason)}`
            : `Account reported for ${phrase(r.reason)}`),
    detail: r.details,
    createdAt: r.createdAt.toISOString(),
    person: who(r.reporterId),
    about: who(r.targetUserId),
    assignedTo: who(r.assignedToId),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionNote: r.resolutionNote,
    replyCount: reply?.count ?? 0,
    lastReplyAt: reply?.last?.toISOString() ?? null,
  };
}

function buildVideoCard(r: VideoRow, who: Lookup, reply: Reply): TicketCard {
  return {
    ref: `v:${r.id}`,
    category: "USER_REPORT",
    kind: "video",
    status: r.status,
    subject: r.video.caption
      ? `Video reported for ${phrase(r.reason)}: ${r.video.caption.slice(0, 80)}`
      : `Video reported for ${phrase(r.reason)}`,
    detail: r.details,
    createdAt: r.createdAt.toISOString(),
    person: who(r.reporterId),
    about: r.video.author,
    assignedTo: who(r.assignedToId),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolutionNote: r.resolutionNote,
    replyCount: reply?.count ?? 0,
    lastReplyAt: reply?.last?.toISOString() ?? null,
  };
}

async function lookupPeople(ids: Array<string | null>): Promise<Lookup> {
  const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  const people = new Map(
    (await prisma.user.findMany({ where: { id: { in: wanted } }, select: PERSON })).map((u) => [u.id, u]),
  );
  return (id) => (id ? people.get(id) ?? null : null);
}

const ACTIVE: ReportStatus[] = ["OPEN", "IN_PROGRESS", "INVESTIGATING"];
const CLOSED: ReportStatus[] = ["COMPLETED", "RESOLVED", "DISMISSED"];

export interface ListParams {
  /** Open work by default; the archive asks for the closed ones. */
  status: "OPEN" | "ACTIVE" | "CLOSED" | "ALL";
  category?: TicketCategory;
  /** Only tickets this person has claimed. */
  assignedToId?: string;
  /** Only tickets this person FILED. Different question from assignedToId, and the reason both
   *  exist: "mine" means one thing to a moderator working a queue and another to someone who
   *  opened a support ticket. */
  reporterId?: string;
  limit: number;
}

function statusFilter(status: ListParams["status"]): ReportStatus[] | undefined {
  if (status === "OPEN") return ["OPEN"];
  if (status === "ACTIVE") return ACTIVE;
  if (status === "CLOSED") return CLOSED;
  return undefined;
}

export async function listTickets(params: ListParams): Promise<{
  tickets: TicketCard[];
  counts: { open: number; mine: number; byCategory: Record<string, number> };
}> {
  const statuses = statusFilter(params.status);
  // The archive is read newest-first. It used to share the work queue's oldest-first order, so once
  // more than `limit` tickets had been closed the most recent ones could never be seen at all.
  const closedFirstNewest = params.status === "CLOSED";
  const where = {
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(params.assignedToId ? { assignedToId: params.assignedToId } : {}),
    ...(params.reporterId ? { reporterId: params.reporterId } : {}),
  };

  // Both tables, then merged and sorted as one. Each is asked for the full page limit because
  // either could supply all of it — taking half from each would hide the newest tickets of a busy
  // queue behind older ones from a quiet one.
  const [content, video] = await Promise.all([
    prisma.contentReport.findMany({
      where: { ...where, ...(params.category ? { category: params.category } : {}) },
      orderBy: closedFirstNewest ? [{ resolvedAt: "desc" }, { createdAt: "desc" }] : [{ status: "asc" }, { createdAt: "asc" }],
      take: params.limit,
    }),
    // A video report is always somebody reporting something, so it is excluded outright when the
    // queue is filtered to another category — rather than fetched and then dropped.
    params.category && params.category !== "USER_REPORT"
      ? Promise.resolve([] as VideoRow[])
      : (prisma.videoReport.findMany({
          where,
          orderBy: closedFirstNewest ? [{ resolvedAt: "desc" }, { createdAt: "desc" }] : [{ status: "asc" }, { createdAt: "asc" }],
          take: params.limit,
          include: { video: { select: { caption: true, author: { select: PERSON } } } },
        }) as unknown as Promise<VideoRow[]>),
  ]);

  // People are resolved in one pass: ContentReport's ids are bare scalars with no relation to join
  // through (a report must outlive what it is about), so this is the only way to show who filed
  // each one without a query per card.
  const who = await lookupPeople([
    ...content.flatMap((r) => [r.reporterId, r.targetUserId, r.assignedToId]),
    ...video.flatMap((r) => [r.reporterId, r.assignedToId]),
  ]);

  const replies = await replyCounts([
    ...content.map((r) => `c:${r.id}`),
    ...video.map((r) => `v:${r.id}`),
  ]);

  const cards: TicketCard[] = [
    ...content.map((r) => buildContentCard(r, who, replies.get(`c:${r.id}`))),
    ...video.map((r) => buildVideoCard(r, who, replies.get(`v:${r.id}`))),
  ]
    // Open first, then oldest first within that. A queue worked newest-first leaves its hardest
    // tickets sitting at the bottom forever. The archive is the reverse: most recently closed first.
    .sort((a, b) => {
      if (closedFirstNewest) return (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt);
      const openA = ACTIVE.includes(a.status) ? 0 : 1;
      const openB = ACTIVE.includes(b.status) ? 0 : 1;
      if (openA !== openB) return openA - openB;
      return a.createdAt.localeCompare(b.createdAt);
    })
    .slice(0, params.limit);

  const [openContent, openVideo, mineContent, mineVideo, byCategory] = await Promise.all([
    prisma.contentReport.count({ where: { status: { in: ACTIVE } } }),
    prisma.videoReport.count({ where: { status: { in: ACTIVE } } }),
    params.assignedToId
      ? prisma.contentReport.count({ where: { status: { in: ACTIVE }, assignedToId: params.assignedToId } })
      : Promise.resolve(0),
    params.assignedToId
      ? prisma.videoReport.count({ where: { status: { in: ACTIVE }, assignedToId: params.assignedToId } })
      : Promise.resolve(0),
    prisma.contentReport.groupBy({ by: ["category"], where: { status: { in: ACTIVE } }, _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = Object.fromEntries(
    byCategory.map((c) => [c.category, c._count._all]),
  );
  // Video reports ARE user reports, and the tab that says so has to count them.
  counts.USER_REPORT = (counts.USER_REPORT ?? 0) + openVideo;

  return {
    tickets: cards,
    counts: { open: openContent + openVideo, mine: mineContent + mineVideo, byCategory: counts },
  };
}

/** What was actually reported, so the person working the ticket can judge it without leaving it. */
export type TicketTarget =
  | {
      kind: "message";
      messageId: string;
      content: string;
      createdAt: string;
      deleted: boolean;
      location: string;
      author: Person | null;
      attachments: Array<{ id: string; url: string; fileName: string; mimeType: string; removed: boolean; reported: boolean }>;
    }
  | { kind: "video"; video: VideoDTO }
  | {
      kind: "user";
      user: Person & { bio: string | null; createdAt: string; isMinor: boolean; banned: boolean };
    }
  | { kind: "gone"; what: string };

export interface TicketDetail extends TicketCard {
  /** Staff only - the reporter's own view of their ticket never carries this. */
  target?: TicketTarget | null;
  messages: Array<{
    id: string;
    body: string;
    fromStaff: boolean;
    internal: boolean;
    createdAt: string;
    author: Person | null;
  }>;
}

/**
 * One ticket, with both sides of the conversation.
 *
 * Reads the single row rather than searching the queue for it: the queue is paginated and ordered
 * for working through, so an older ticket simply would not be in it — and widening the page until
 * it was would mean loading the table to open one card.
 *
 * `includeInternal` is false for the person who filed it. Staff leave notes to each other on a
 * ticket, and those are not part of what a reporter is shown.
 */
export async function getTicket(ref: string, includeInternal: boolean): Promise<TicketDetail> {
  const { table, id } = splitRef(ref);

  const [card, messages] = await Promise.all([
    table === "content" ? contentCard(id) : videoCard(id),
    prisma.ticketMessage.findMany({
      where: { ticketRef: ref, ...(includeInternal ? {} : { internal: false }) },
      orderBy: { createdAt: "asc" },
      include: { author: { select: PERSON } },
    }),
  ]);

  return {
    ...card,
    ...(includeInternal ? { target: await ticketTarget(table, id) } : {}),
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      fromStaff: m.fromStaff,
      internal: m.internal,
      createdAt: m.createdAt.toISOString(),
      author: m.author,
    })),
  };
}

function describeLocation(message: {
  channel: { name: string; server: { name: string } | null } | null;
  dmConversationId: string | null;
}): string {
  if (message.channel) {
    const server = message.channel.server?.name;
    return server ? `${server} · #${message.channel.name}` : `#${message.channel.name}`;
  }
  return message.dmConversationId ? "Direct message" : "Unknown";
}

/**
 * Looks up the thing a report is about. A ContentReport stores bare ids (no relations) because a
 * ticket has to outlive what it refers to, so this resolves them at read time and says "gone"
 * rather than failing when the target has since been deleted.
 */
async function ticketTarget(table: "content" | "video", id: string): Promise<TicketTarget | null> {
  if (table === "video") {
    const report = await prisma.videoReport.findUnique({ where: { id }, select: { videoId: true } });
    if (!report) return null;
    const video = await prisma.video.findUnique({
      where: { id: report.videoId },
      include: { author: { select: VIDEO_AUTHOR_SELECT }, ...VIDEO_TAGS_INCLUDE, ...VIDEO_SOURCE_INCLUDE },
    });
    return video ? { kind: "video", video: serializeVideoWithStatus(video) } : { kind: "gone", what: "This video no longer exists." };
  }

  const r = await prisma.contentReport.findUnique({
    where: { id },
    select: { targetType: true, targetMessageId: true, targetAttachmentId: true, targetUserId: true },
  });
  if (!r) return null;

  if (r.targetType === "MESSAGE" || r.targetType === "ATTACHMENT") {
    let messageId = r.targetMessageId;
    // An image report names the attachment; the message it belongs to is the context.
    if (messageId === null && r.targetAttachmentId) {
      messageId = (await prisma.attachment.findUnique({ where: { id: r.targetAttachmentId }, select: { messageId: true } }))?.messageId ?? null;
    }
    if (messageId === null) return { kind: "gone", what: "The reported message can't be identified." };
    const m = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        content: true,
        createdAt: true,
        deletedAt: true,
        dmConversationId: true,
        author: { select: PERSON },
        channel: { select: { name: true, server: { select: { name: true } } } },
        attachments: { select: { id: true, url: true, fileName: true, mimeType: true, reviewStatus: true } },
      },
    });
    if (!m) return { kind: "gone", what: "This message no longer exists." };
    return {
      kind: "message",
      messageId: m.id.toString(),
      content: m.content ?? "",
      createdAt: m.createdAt.toISOString(),
      deleted: m.deletedAt !== null,
      location: describeLocation(m),
      author: m.author,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        url: a.url,
        fileName: a.fileName,
        mimeType: a.mimeType,
        removed: a.reviewStatus === "REMOVED",
        reported: a.id === r.targetAttachmentId,
      })),
    };
  }

  if (r.targetType === "USER" && r.targetUserId) {
    const u = await prisma.user.findUnique({
      where: { id: r.targetUserId },
      select: {
        ...PERSON,
        bio: true,
        createdAt: true,
        isMinor: true,
        platformBans: { where: { scope: "ACCOUNT", liftedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!u) return { kind: "gone", what: "This account no longer exists." };
    return {
      kind: "user",
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        bio: u.bio,
        createdAt: u.createdAt.toISOString(),
        isMinor: u.isMinor,
        banned: u.platformBans.length > 0,
      },
    };
  }
  return null;
}

async function contentCard(id: string): Promise<TicketCard> {
  const r = await prisma.contentReport.findUnique({ where: { id } });
  if (!r) throw new NotFoundError("Ticket not found");
  const who = await lookupPeople([r.reporterId, r.targetUserId, r.assignedToId]);
  return buildContentCard(r, who, (await replyCounts([`c:${id}`])).get(`c:${id}`));
}

async function videoCard(id: string): Promise<TicketCard> {
  const r = (await prisma.videoReport.findUnique({
    where: { id },
    include: { video: { select: { caption: true, author: { select: PERSON } } } },
  })) as VideoRow | null;
  if (!r) throw new NotFoundError("Ticket not found");
  const who = await lookupPeople([r.reporterId, r.assignedToId]);
  return buildVideoCard(r, who, (await replyCounts([`v:${id}`])).get(`v:${id}`));
}

/** Who filed a ticket — the only non-staff account allowed to read or reply to it. */
export async function ticketOwnerId(ref: string): Promise<string | null> {
  const { table, id } = splitRef(ref);
  const row =
    table === "content"
      ? await prisma.contentReport.findUnique({ where: { id }, select: { reporterId: true } })
      : await prisma.videoReport.findUnique({ where: { id }, select: { reporterId: true } });
  if (!row) throw new NotFoundError("Ticket not found");
  return row.reporterId;
}

export async function claimTicket(ref: string, actorId: string, status: "IN_PROGRESS" | "INVESTIGATING") {
  const { table, id } = splitRef(ref);
  // Claimed only if it is still unclaimed (or already ours), decided in the write itself: two people
  // pressing Claim in the same second used to both succeed, the later one silently taking the
  // ticket off the first, and the screen only stopped offering it AFTER someone had lost it.
  const free = { id, status: { in: ACTIVE }, OR: [{ assignedToId: null }, { assignedToId: actorId }] };
  const { count } =
    table === "content"
      ? // ContentReport has no assignedAt column of its own; everything else matches VideoReport.
        await prisma.contentReport.updateMany({ where: free, data: { status, assignedToId: actorId } })
      : await prisma.videoReport.updateMany({ where: free, data: { status, assignedToId: actorId, assignedAt: new Date() } });
  if (count === 0) {
    const row =
      table === "content"
        ? await prisma.contentReport.findUnique({ where: { id }, select: { status: true } })
        : await prisma.videoReport.findUnique({ where: { id }, select: { status: true } });
    if (!row) throw new NotFoundError("Ticket not found");
    if (!ACTIVE.includes(row.status)) throw new BadRequestError("That ticket is already closed");
    throw new ForbiddenError("That ticket was just claimed by someone else");
  }
}

export async function releaseTicket(ref: string, actorId: string) {
  const { table, id } = splitRef(ref);
  const current =
    table === "content"
      ? await prisma.contentReport.findUnique({ where: { id }, select: { assignedToId: true } })
      : await prisma.videoReport.findUnique({ where: { id }, select: { assignedToId: true } });
  if (!current) throw new NotFoundError("Ticket not found");
  // Releasing someone else's ticket would take it off them mid-investigation without telling them.
  if (current.assignedToId && current.assignedToId !== actorId) {
    throw new ForbiddenError("That ticket is claimed by someone else");
  }
  if (table === "content") {
    await prisma.contentReport.update({ where: { id }, data: { status: "OPEN", assignedToId: null } });
  } else {
    await prisma.videoReport.update({
      where: { id },
      data: { status: "OPEN", assignedToId: null, assignedAt: null },
    });
  }
}

export async function completeTicket(
  ref: string,
  actorId: string,
  outcome: "COMPLETED" | "DISMISSED",
  note: string,
) {
  const { table, id } = splitRef(ref);
  const data = {
    status: outcome,
    resolutionNote: note.slice(0, 1000),
    resolvedById: actorId,
    resolvedAt: new Date(),
  };
  // Only open work can be closed, decided in the write: closing an already-closed ticket overwrote
  // the first reviewer's outcome and note, and an unknown ref was a raw 500 rather than a 404.
  const { count } =
    table === "content"
      ? await prisma.contentReport.updateMany({ where: { id, status: { in: ACTIVE } }, data })
      : await prisma.videoReport.updateMany({ where: { id, status: { in: ACTIVE } }, data });
  if (count === 0) {
    const exists =
      table === "content"
        ? await prisma.contentReport.findUnique({ where: { id }, select: { id: true } })
        : await prisma.videoReport.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundError("Ticket not found");
    throw new BadRequestError("That ticket was already closed");
  }

  // The closing note is the last thing said on the ticket, so it belongs in the conversation too.
  // Without this the archive shows an exchange that simply stops, with the outcome recorded
  // somewhere the reader of the thread never sees.
  await prisma.ticketMessage.create({
    data: { ticketRef: ref, authorId: actorId, fromStaff: true, internal: false, body: note.slice(0, 4000) },
  });
}

export async function replyToTicket(params: {
  ref: string;
  authorId: string;
  body: string;
  fromStaff: boolean;
  internal: boolean;
}) {
  splitRef(params.ref);
  await prisma.ticketMessage.create({
    data: {
      ticketRef: params.ref,
      authorId: params.authorId,
      fromStaff: params.fromStaff,
      // Only staff can leave an internal note. A reporter marking their own message internal would
      // hide it from the people it is addressed to.
      internal: params.fromStaff && params.internal,
      body: params.body.slice(0, 4000),
    },
  });
}

/** Someone asking for help, rather than reporting somebody. */
export async function openSupportTicket(params: {
  userId: string;
  subject: string;
  body: string;
}): Promise<{ ref: string }> {
  const ticket = await prisma.contentReport.create({
    data: {
      reporterId: params.userId,
      category: "CUSTOMER_SUPPORT",
      // NONE rather than USER: a support ticket is not about anybody, and pointing it at its own
      // author would put the person asking for help into the queue as a reported account.
      targetType: "NONE",
      reason: "OTHER",
      subject: params.subject.slice(0, 200),
      details: params.body.slice(0, 1000),
      status: "OPEN",
    },
  });
  const ref = `c:${ticket.id}`;
  await prisma.ticketMessage.create({
    data: {
      ticketRef: ref,
      authorId: params.userId,
      fromStaff: false,
      internal: false,
      body: params.body.slice(0, 4000),
    },
  });
  void notifyStaffOfQueueItem({ kind: "support", excludeUserId: params.userId });
  return { ref };
}

/** Raised by the platform itself — the automod, the age barrier audit, a duplicate-device flag. */
export async function openSystemTicket(params: {
  subject: string;
  detail: string;
  aboutUserId?: string | null;
}): Promise<{ ref: string }> {
  const ticket = await prisma.contentReport.create({
    data: {
      reporterId: null,
      category: "SYSTEM_FLAGGED",
      targetType: params.aboutUserId ? "USER" : "NONE",
      targetUserId: params.aboutUserId ?? null,
      reason: "OTHER",
      subject: params.subject.slice(0, 200),
      details: params.detail.slice(0, 1000),
      status: "OPEN",
    },
  });
  // No excludeUserId: the platform raised this one, so there is nobody whose own action it was.
  void notifyStaffOfQueueItem({ kind: "system" });
  return { ref: `c:${ticket.id}` };
}
