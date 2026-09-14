import { prisma } from "../../db/prisma.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { serializeUser } from "../../lib/serialize.js";
import { pushInboxNotification } from "../inbox/service.js";
import { sendPushToUser } from "../../lib/push.js";

/**
 * The feed: posts, likes, comments and shares.
 *
 * Separate from the video feed (modules/feed) rather than folded into it. There, the video IS the
 * post — one file, ranked by watch signals, with no text of its own. Here a post is text that may
 * or may not carry media, and is read in order. One model for both would be a table where half the
 * columns are null for half the rows.
 *
 * ## Counters are denormalised on purpose
 *
 * A feed page is twenty posts. Counting likes, comments and shares per post would be sixty
 * aggregate queries to render one screen, for numbers that are read constantly and change rarely.
 * Every write that moves a count does so in the same transaction as the row it counts, so the two
 * cannot drift.
 */

const POST_AUTHOR = {
  id: true, username: true, displayName: true, avatarUrl: true, bannerUrl: true,
  bio: true, pronouns: true, statusText: true, statusEmoji: true, presence: true,
  isBot: true, isOfficial: true, premiumUntil: true, platformRole: true,
} as const;

type Viewer = string | null;

function postInclude(viewerId: Viewer) {
  return {
    author: { select: POST_AUTHOR },
    media: { orderBy: { position: "asc" } },
    // Whether the VIEWER has liked it, fetched as a zero-or-one row rather than as a second query
    // per post. `_count` cannot answer "did I", only "how many".
    likes: viewerId ? { where: { userId: viewerId }, select: { userId: true } } : false,
  } as const;
}

export interface PostDTO {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: ReturnType<typeof serializeUser> | null;
  media: Array<{ id: string; kind: string; url: string; width: number | null; height: number | null }>;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  likedByMe: boolean;
  /** The post this one shares, already serialised. Null when it is not a share. */
  shared: PostDTO | null;
  /** True when this IS a share whose original has since been deleted. */
  sharedUnavailable: boolean;
  mine: boolean;
}

type PostRow = Awaited<ReturnType<typeof prisma.post.findFirstOrThrow>> & {
  author?: unknown;
  media?: Array<{ id: string; kind: string; url: string; width: number | null; height: number | null }>;
  likes?: Array<{ userId: string }>;
  shared?: PostRow | null;
};

function serializePost(row: PostRow, viewerId: Viewer, shared: PostDTO | null = null): PostDTO {
  return {
    id: row.id.toString(),
    // A deleted post keeps its row so shares of it do not dangle, but it must not keep showing its
    // words — deleting has to mean something.
    body: row.deletedAt ? "" : row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    author: row.author ? serializeUser(row.author as Parameters<typeof serializeUser>[0]) : null,
    media: row.deletedAt ? [] : (row.media ?? []),
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    shareCount: row.shareCount,
    likedByMe: (row.likes?.length ?? 0) > 0,
    shared,
    sharedUnavailable: false,
    mine: Boolean(viewerId && row.authorId === viewerId),
  };
}

/**
 * "Someone did something to your post."
 *
 * Fire-and-forget from every caller, the same rule the message path uses: a like must never wait on
 * a notification write, and a lost notification is an acceptable loss where a slow like is not.
 *
 * pushInboxNotification already refuses to notify you about your own actions and bundles repeats
 * into one row, so twenty likes on one post are one line saying twenty — not twenty lines.
 *
 * The push is deliberately only sent for the FIRST actor in a bundle. The inbox can afford to say
 * "and 19 others" quietly; a phone buzzing twenty times cannot, and that is how people turn
 * notifications off for good.
 */
async function notifyPostAuthor(params: {
  postId: bigint;
  actorId: string;
  kind: "POST_LIKE" | "POST_COMMENT" | "POST_SHARE";
  verb: string;
}): Promise<void> {
  const post = await prisma.post.findUnique({
    where: { id: params.postId },
    select: { authorId: true, body: true, deletedAt: true },
  });
  if (!post?.authorId || post.deletedAt || post.authorId === params.actorId) return;

  const bundleKey = `${params.kind}:${params.postId}`;
  const existing = await prisma.notification.findUnique({
    where: { userId_bundleKey: { userId: post.authorId, bundleKey } },
    select: { id: true },
  });

  await pushInboxNotification({
    userId: post.authorId,
    kind: params.kind,
    bundleKey,
    actorId: params.actorId,
    postId: params.postId,
    preview: post.body.slice(0, 140) || null,
  });

  if (existing) return;
  const actor = await prisma.user.findUnique({
    where: { id: params.actorId },
    select: { username: true, displayName: true },
  });
  const who = actor?.displayName ?? actor?.username ?? "Someone";
  await sendPushToUser(post.authorId, {
    title: `${who} ${params.verb}`,
    body: post.body.slice(0, 120) || "your post",
    url: "/feed",
    tag: bundleKey,
  }).catch(() => undefined);
}

export async function listFeed(params: {
  viewerId: Viewer;
  limit: number;
  cursor?: string;
  authorId?: string;
}): Promise<{ posts: PostDTO[]; nextCursor: string | null }> {
  const where = {
    deletedAt: null,
    ...(params.authorId ? { authorId: params.authorId } : {}),
    ...(params.cursor ? { id: { lt: BigInt(params.cursor) } } : {}),
  };

  const rows = await prisma.post.findMany({
    where,
    // By id rather than createdAt: ids are strictly increasing, so paging on one cannot skip or
    // repeat a row when two posts share a timestamp.
    orderBy: { id: "desc" },
    take: params.limit + 1,
    include: {
      ...postInclude(params.viewerId),
      shared: { include: postInclude(params.viewerId) },
    },
  });

  const page = rows.slice(0, params.limit);
  return {
    posts: page.map((row) => {
      const inner = (row as PostRow).shared;
      const sharedDto = inner && !inner.deletedAt
        ? serializePost(inner, params.viewerId)
        : null;
      const dto = serializePost(row as PostRow, params.viewerId, sharedDto);
      // A share whose original is gone still renders, saying so — rather than vanishing and
      // leaving whoever shared it wondering where their post went.
      dto.sharedUnavailable = Boolean(row.sharedPostId && !sharedDto);
      return dto;
    }),
    nextCursor: rows.length > params.limit ? page[page.length - 1]?.id.toString() ?? null : null,
  };
}

export async function getPost(id: bigint, viewerId: Viewer): Promise<PostDTO> {
  const row = await prisma.post.findUnique({
    where: { id },
    include: { ...postInclude(viewerId), shared: { include: postInclude(viewerId) } },
  });
  if (!row || row.deletedAt) throw new NotFoundError("Post not found");
  const inner = (row as PostRow).shared;
  const sharedDto = inner && !inner.deletedAt ? serializePost(inner, viewerId) : null;
  const dto = serializePost(row as PostRow, viewerId, sharedDto);
  dto.sharedUnavailable = Boolean(row.sharedPostId && !sharedDto);
  return dto;
}

export interface CreatePostMedia {
  id: string;
  kind: "PHOTO" | "VIDEO";
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export async function createPost(params: {
  authorId: string;
  body: string;
  media?: CreatePostMedia[];
  sharedPostId?: bigint | null;
}): Promise<PostDTO> {
  const body = params.body.trim().slice(0, 20000);
  const media = params.media ?? [];
  // A post has to BE something. An empty one is almost always a mis-tap on the post button, and
  // the feed is worse for every blank card in it.
  if (!body && media.length === 0 && !params.sharedPostId) {
    throw new BadRequestError("Write something, or add a photo or video");
  }

  let sharedPostId: bigint | null = null;
  if (params.sharedPostId) {
    const target = await prisma.post.findUnique({
      where: { id: params.sharedPostId },
      select: { id: true, deletedAt: true, sharedPostId: true },
    });
    if (!target || target.deletedAt) throw new NotFoundError("That post is no longer available");
    // Sharing a share points at the ORIGINAL. Otherwise a chain of shares nests one card inside
    // another inside another, and the thing everyone actually wants to see ends up three frames deep.
    sharedPostId = target.sharedPostId ?? target.id;
  }

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        authorId: params.authorId,
        body,
        sharedPostId,
        media: media.length
          ? {
              create: media.map((m, i) => ({
                id: m.id,
                kind: m.kind,
                url: m.url,
                mimeType: m.mimeType,
                sizeBytes: m.sizeBytes,
                width: m.width ?? null,
                height: m.height ?? null,
                position: i,
              })),
            }
          : undefined,
      },
      select: { id: true },
    });
    if (sharedPostId) {
      await tx.post.update({ where: { id: sharedPostId }, data: { shareCount: { increment: 1 } } });
    }
    return created;
  });

  if (sharedPostId) {
    void notifyPostAuthor({
      postId: sharedPostId,
      actorId: params.authorId,
      kind: "POST_SHARE",
      verb: "shared your post",
    }).catch(() => undefined);
  }

  return getPost(post.id, params.authorId);
}

export async function deletePost(id: bigint, userId: string): Promise<void> {
  const post = await prisma.post.findUnique({
    where: { id },
    select: { authorId: true, deletedAt: true, sharedPostId: true },
  });
  if (!post || post.deletedAt) throw new NotFoundError("Post not found");
  if (post.authorId !== userId) throw new ForbiddenError("That isn't your post");

  await prisma.$transaction(async (tx) => {
    // Soft: shares of it still exist, and hard-deleting would take their cards with them.
    await tx.post.update({ where: { id }, data: { deletedAt: new Date() } });
    // Deleting a SHARE has to give the original its count back. Without this the number only ever
    // went up: share, delete, share again, and a post claims three shares it does not have — and a
    // denormalised counter that can drift is one nobody trusts afterwards.
    if (post.sharedPostId) {
      await tx.post.update({
        where: { id: post.sharedPostId },
        data: { shareCount: { decrement: 1 } },
      });
    }
  });
}

/** Returns the resulting state, so the caller does not have to guess which way it went. */
export async function toggleLike(postId: bigint, userId: string): Promise<{ liked: boolean; likeCount: number }> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { deletedAt: true } });
  if (!post || post.deletedAt) throw new NotFoundError("Post not found");

  const result = await prisma.$transaction(async (tx) => {
    // deleteMany rather than delete: it reports how many rows it removed instead of throwing when
    // there were none, which is exactly the "was it liked" question being asked.
    const removed = await tx.postLike.deleteMany({ where: { postId, userId } });
    if (removed.count > 0) {
      const updated = await tx.post.update({
        where: { id: postId },
        // Floored at zero: a counter that can go negative from a double-unlike is a counter nobody
        // trusts again.
        data: { likeCount: { decrement: 1 } },
        select: { likeCount: true },
      });
      return { liked: false, likeCount: Math.max(0, updated.likeCount) };
    }
    await tx.postLike.create({ data: { postId, userId } });
    const updated = await tx.post.update({
      where: { id: postId },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    return { liked: true, likeCount: updated.likeCount };
  });

  // After the transaction, matching the comment and share paths. Only on the way UP: unliking is
  // not an event anyone wants told about, and re-liking bumps the existing bundle rather than
  // producing a second one.
  if (result.liked) {
    void notifyPostAuthor({ postId, actorId: userId, kind: "POST_LIKE", verb: "liked your post" })
      .catch(() => undefined);
  }
  return result;
}

export interface CommentDTO {
  id: string;
  body: string;
  createdAt: string;
  author: ReturnType<typeof serializeUser> | null;
  likeCount: number;
  likedByMe: boolean;
  mine: boolean;
  replies: CommentDTO[];
}

export async function listComments(postId: bigint, viewerId: Viewer): Promise<CommentDTO[]> {
  const rows = await prisma.postComment.findMany({
    where: { postId, deletedAt: null },
    orderBy: { id: "asc" },
    include: {
      author: { select: POST_AUTHOR },
      likes: viewerId ? { where: { userId: viewerId }, select: { userId: true } } : false,
    },
  });

  const toDto = (row: (typeof rows)[number]): CommentDTO => ({
    id: row.id.toString(),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: row.author ? serializeUser(row.author as Parameters<typeof serializeUser>[0]) : null,
    likeCount: row.likeCount,
    likedByMe: ((row as { likes?: unknown[] }).likes?.length ?? 0) > 0,
    mine: Boolean(viewerId && row.authorId === viewerId),
    replies: [],
  });

  // Assembled in one pass rather than a query per level. Threading is capped at one level (see the
  // migration), so a map of top-level comments and a single sweep for replies is the whole job.
  const byId = new Map<string, CommentDTO>();
  const top: CommentDTO[] = [];
  for (const row of rows) {
    const dto = toDto(row);
    byId.set(dto.id, dto);
    if (!row.parentId) top.push(dto);
  }
  for (const row of rows) {
    if (!row.parentId) continue;
    byId.get(row.parentId.toString())?.replies.push(byId.get(row.id.toString())!);
  }
  return top;
}

export async function addComment(params: {
  postId: bigint;
  authorId: string;
  body: string;
  parentId?: bigint | null;
}): Promise<CommentDTO[]> {
  const body = params.body.trim().slice(0, 4000);
  if (!body) throw new BadRequestError("Write something first");

  const post = await prisma.post.findUnique({ where: { id: params.postId }, select: { deletedAt: true } });
  if (!post || post.deletedAt) throw new NotFoundError("Post not found");

  let parentId: bigint | null = null;
  if (params.parentId) {
    const parent = await prisma.postComment.findUnique({
      where: { id: params.parentId },
      select: { id: true, postId: true, parentId: true, deletedAt: true },
    });
    if (!parent || parent.deletedAt || parent.postId !== params.postId) {
      throw new NotFoundError("That comment is no longer there");
    }
    // Replying to a reply attaches to its parent, so the thread stays two levels deep instead of
    // walking off the right edge of a phone.
    parentId = parent.parentId ?? parent.id;
  }

  await prisma.$transaction(async (tx) => {
    await tx.postComment.create({ data: { postId: params.postId, authorId: params.authorId, body, parentId } });
    await tx.post.update({ where: { id: params.postId }, data: { commentCount: { increment: 1 } } });
  });

  void notifyPostAuthor({
    postId: params.postId,
    actorId: params.authorId,
    kind: "POST_COMMENT",
    verb: "commented on your post",
  }).catch(() => undefined);

  return listComments(params.postId, params.authorId);
}

export async function deleteComment(id: bigint, userId: string): Promise<void> {
  const comment = await prisma.postComment.findUnique({
    where: { id },
    select: { authorId: true, postId: true, deletedAt: true, parentId: true },
  });
  if (!comment || comment.deletedAt) throw new NotFoundError("Comment not found");
  if (comment.authorId !== userId) throw new ForbiddenError("That isn't your comment");

  // Replies go with it. listComments assembles a thread by looking each reply's parent up in the
  // map of visible comments, so a soft-deleted parent left its replies pointing at nothing: they
  // disappeared from the thread while their rows stayed undeleted, and the count only fell by one.
  // Removing the whole branch is also what the platforms this is modelled on do.
  const replies = comment.parentId
    ? []
    : await prisma.postComment.findMany({
        where: { parentId: id, deletedAt: null },
        select: { id: true },
      });

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.postComment.updateMany({
      where: { id: { in: [id, ...replies.map((r) => r.id)] }, deletedAt: null },
      data: { deletedAt: now },
    });
    await tx.post.update({
      where: { id: comment.postId },
      // Floored by the caller's own read: the count must fall by exactly what stopped being
      // visible, which is the comment plus every reply under it.
      data: { commentCount: { decrement: 1 + replies.length } },
    });
  });
}

export async function toggleCommentLike(
  commentId: bigint,
  userId: string,
): Promise<{ liked: boolean; likeCount: number }> {
  const comment = await prisma.postComment.findUnique({ where: { id: commentId }, select: { deletedAt: true } });
  if (!comment || comment.deletedAt) throw new NotFoundError("Comment not found");

  return prisma.$transaction(async (tx) => {
    const removed = await tx.postCommentLike.deleteMany({ where: { commentId, userId } });
    if (removed.count > 0) {
      const updated = await tx.postComment.update({
        where: { id: commentId },
        data: { likeCount: { decrement: 1 } },
        select: { likeCount: true },
      });
      return { liked: false, likeCount: Math.max(0, updated.likeCount) };
    }
    await tx.postCommentLike.create({ data: { commentId, userId } });
    const updated = await tx.postComment.update({
      where: { id: commentId },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    return { liked: true, likeCount: updated.likeCount };
  });
}
